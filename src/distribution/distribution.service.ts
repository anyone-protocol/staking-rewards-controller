import { Inject, Injectable, Logger } from '@nestjs/common'
import { ScoreData } from './schemas/score-data'
import { ConfigService } from '@nestjs/config'
import _ from 'lodash'
import { StakingRewardsService } from 'src/staking-rewards/staking-rewards.service'
import { AddScoresData } from './dto/add-scores'
import RoundSnapshot from './dto/round-snapshot'
import { HttpService } from '@nestjs/axios'
import { AxiosError } from 'axios'
import { firstValueFrom, catchError } from 'rxjs'
import { RelayInfo } from './interfaces/8_3/relay-info'
import { DetailsResponse } from './interfaces/8_3/details-response'
import { OperatorRegistryService } from 'src/operator-registry/operator-registry.service'
import { TasksService } from 'src/tasks/tasks.service'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { differenceInDays, startOfDay, subDays } from 'date-fns'
import { BundlingService } from '../bundling/bundling.service'
import { ethers, lock } from 'ethers'

@Injectable()
export class DistributionService {
  private readonly logger = new Logger(DistributionService.name)

  private isLive?: string
  private minHealthyConsensusWeight = 50

  private static readonly scoresPerBatch = 420

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      BUNDLER_NODE: string
      BUNDLER_NETWORK: string
      BUNDLER_CONTROLLER_KEY: string
      ONIONOO_DETAILS_URI: string
      DETAILS_URI_AUTH: string
      MIN_HEALTHY_CONSENSUS_WEIGHT: number
    }>,
    private readonly stakingRewardsService: StakingRewardsService,
    private readonly operatorRegistryService: OperatorRegistryService,
    private readonly httpService: HttpService,
    private readonly tasksService: TasksService,
    private readonly bundlingService: BundlingService
  ) {
    this.isLive = config.get<string>('IS_LIVE', { infer: true })
    this.minHealthyConsensusWeight = config.get<number>(
      'MIN_HEALTHY_CONSENSUS_WEIGHT',
      { infer: true }
    )
    this.logger.log(
      `Initializing distribution service (IS_LIVE: ${this.isLive})`
    )
  }

  public groupScoreJobs(data: ScoreData[]): ScoreData[][] {
    const scoresByHodler = new Map<string, ScoreData[]>()
    for (const score of data) {
      const hodlerScores = scoresByHodler.get(score.Hodler) || []
      hodlerScores.push(score)
      scoresByHodler.set(score.Hodler, hodlerScores)
    }

    const hodlerGroups = Array.from(scoresByHodler.values())

    const result: ScoreData[][] = []
    let currentBatch: ScoreData[] = []

    for (const hodlerScores of hodlerGroups) {
      if (
        currentBatch.length > 0 &&
        currentBatch.length + hodlerScores.length > DistributionService.scoresPerBatch
      ) {
        result.push(currentBatch)
        currentBatch = []
      }

      currentBatch.push(...hodlerScores)
    }

    if (currentBatch.length > 0) {
      result.push(currentBatch)
    }

    this.logger.log(
      `Created ${result.length} groups out of ${data.length} scores for ${hodlerGroups.length} hodlers`
    )

    return result
  }

  private async fetchRelays(): Promise<RelayInfo[]> {
    var relays: RelayInfo[] = []
    const detailsUri = this.config.get<string>('ONIONOO_DETAILS_URI', {
      infer: true,
    })
    if (detailsUri !== undefined) {
      const detailsAuth: string =
        this.config.get<string>('DETAILS_URI_AUTH', {
          infer: true,
        }) || ''

      try {
        const { headers, status, data } = await firstValueFrom(
          this.httpService
            .get<DetailsResponse>(detailsUri, {
              headers: {
                'content-encoding': 'gzip',
                authorization: `${detailsAuth}`,
              },
              validateStatus: status => status === 304 || status === 200,
            })
            .pipe(
              catchError((error: AxiosError) => {
                this.logger.error(
                  `Fetching relays from ${detailsUri} failed with ${error.response?.status ?? '?'}, ${error}`
                )
                throw 'Failed to fetch relay details'
              })
            )
        )

        this.logger.debug(`Fetch details from ${detailsUri} response ${status}`)
        if (status === 200) {
          relays = data.relays

          this.logger.log(`Received ${relays.length} relays from network details`)
        } else this.logger.debug('No relay updates from network details')
      } catch (e) {
        this.logger.error('Exception when fetching details of network relays', e.stack)
      }
    } else this.logger.warn('Set the ONIONOO_DETAILS_URI in ENV vars or configuration')

    return relays
  }

  public async getCurrentScores(stamp: number): Promise<ScoreData[]> {
    const relaysData = await this.fetchRelays()
    const { locksData, stakingData} = await this.stakingRewardsService.getHodlerData()
    const operatorRegistryState = await this.operatorRegistryService.getOperatorRegistryState()
    const verificationData = operatorRegistryState.VerifiedFingerprintsToOperatorAddresses
    const isHardware = operatorRegistryState.VerifiedHardwareFingerprints
    
    const data: { [key: string]: {
      expected: number,
      running: number,
      found: number
    }} = {}

    Object.keys(verificationData).forEach(fingerprint => {
      const verifiedAddress = verificationData[fingerprint]
      if (verifiedAddress && verifiedAddress.length > 0) {
        const pVA = ethers.getAddress(verifiedAddress)
        if (!data[pVA]) {
          data[pVA] = { expected: 0, running: 0, found: 0 }
        }
        data[pVA].expected = data[pVA].expected + 1
      }
    })
    
    relaysData.forEach(relay => {
      const verifiedAddress = verificationData[relay.fingerprint]
      if (verifiedAddress && verifiedAddress.length > 0) {
        const pVA = ethers.getAddress(verifiedAddress)
        data[pVA].found = data[pVA].found + 1

        if ((
              isHardware[relay.fingerprint] ||
              (locksData[relay.fingerprint] && locksData[relay.fingerprint].includes(pVA)) 
            ) && 
            relay.running && relay.consensus_weight > this.minHealthyConsensusWeight) {
          data[pVA].running = data[pVA].running + 1
        }
      } else {
        // this.logger.debug(`Found unverified relay ${relay.fingerprint}`)
      }
    })

    const scores = []

    Object.keys(data).forEach(operator => {
      const runningShare = Math.max(0, Math.min(data[operator].running / data[operator].expected, 1))
      this.logger.debug(`Operator ${operator} has ${data[operator].expected} expected, ${data[operator].running} running and ${data[operator].found} found relays. Running share: ${runningShare}`)
      if (stakingData[operator]) {
        Object.keys(stakingData[operator]).forEach(hodler => {
          const staked = stakingData[operator][hodler] ?? '0'
          if (staked !== '0') {
            scores.push({
              Hodler: hodler,
              Operator: operator,
              Running: runningShare,
              Staked: staked
            })
          }
        })
      }
    })

    const stakesSummary = {}
    Object.keys(stakingData).forEach(operator => {
      var stakePerOperator = BigInt(0)
      Object.keys(stakingData[operator]).forEach(hodler => {
        if (stakingData[operator][hodler]) {
          stakePerOperator += BigInt(stakingData[operator][hodler])
        }
      })
      this.logger.debug(`Operator ${operator} has total stake of ${stakePerOperator.toString()}`)
      const staked = stakePerOperator.toString()
      if (staked !== '0') {
        stakesSummary[operator] = staked
      }
    })

    const summary = {
      Timestamp: stamp,
      Stakes: stakesSummary,
      Network: data
    }
    
    if (this.isLive !== 'true') {
      this.logger.warn(`NOT LIVE: Not storing staking/snapshot [${stamp}]`)
    } else {
      try {
        const tags = [
          { name: 'Protocol', value: 'ANyONe' },
          { name: 'Protocol-Version', value: '0.2' },
          { name: 'Content-Timestamp', value: stamp.toString() },
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Entity-Type', value: 'staking/snapshot' },
        ]

        const { id: summary_tx } = await this.bundlingService.upload(
          JSON.stringify(summary), { tags }
        )

        this.logger.log(`Permanently stored staking/snaphot [${stamp}]: ${summary_tx}`)
      } catch (error) {
        this.logger.error(`Exception in staking distribution service persisting snapshot: ${error.message}`, error.stack)
      }
    }

    return scores
  }

  public async addScores(stamp: number, scores: ScoreData[]): Promise<boolean> {
    const scoresForLua: AddScoresData = {}
    scores.forEach(score => {
      const hodlerNormalized = '0x' + score.Hodler.substring(2).toUpperCase()
      const operatorNormalized = '0x' + score.Operator.substring(2).toUpperCase()
      if (!scoresForLua[hodlerNormalized]) {
        scoresForLua[hodlerNormalized] = {}
      }

      scoresForLua[hodlerNormalized][operatorNormalized] = {
        Staked: score.Staked,
        Running: score.Running
      }
    })

    return this.stakingRewardsService.addScores(stamp, scoresForLua)
  }

  public async complete(stamp: number): Promise<boolean> {
    const result = await this.stakingRewardsService.completeRound(stamp)
    if (result) {
      this.tasksService.updateDistribution(stamp, true, false)
    }
    return result
  }

  public async persistRound(stamp: number): Promise<boolean> {
    const snapshot: RoundSnapshot | undefined = await this.stakingRewardsService.getLastSnapshot()

    if (!snapshot || snapshot.Timestamp == 0) {
      this.logger.error('Last snapshot not found')
      return false
    }

    if (snapshot.Timestamp != stamp || snapshot.Timestamp != stamp) {
      this.logger.warn(
        "Different stamp in returned for previous round. Skipping persistence as either there is a newer one, or can't confirm the round was sucessfully completed"
      )
      return false
    }
    try {
      if (this.isLive !== 'true') {
        this.logger.warn(`NOT LIVE: Not storing staking/summary [${snapshot.Timestamp}]`)

        return false
      }

      const tags = [
        { name: 'Protocol', value: 'ANyONe' },
        { name: 'Protocol-Version', value: '0.2' },
        {
          name: 'Content-Timestamp',
          value: snapshot.Timestamp.toString(),
        },
        {
          name: 'Content-Type',
          value: 'application/json',
        },
        { name: 'Entity-Type', value: 'staking/summary' },

        { name: 'Time-Elapsed', value: snapshot.Period.toString() },
        { name: 'Distribution-Rate', value: snapshot.Configuration.TokensPerSecond },
        { name: 'Distributed-Tokens', value: snapshot.Summary.Rewards }
      ]

      const { id: summary_tx } = await this.bundlingService.upload(
        JSON.stringify(snapshot),
        { tags }
      )

      this.logger.log(`Permanently stored staking/summary [${stamp}]: ${summary_tx}`)
      this.tasksService.updateDistribution(stamp, true, true)
      return true
    } catch (error) {
      this.logger.error(`Exception in staking distribution service persisting round: ${error.message}`, error.stack)
    }

    return false
  }
}
