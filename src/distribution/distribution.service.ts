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
import { latLngToCell } from 'h3-js'
import * as geoip from 'geoip-lite'
import { RelayInfo } from './interfaces/8_3/relay-info'
import { DetailsResponse } from './interfaces/8_3/details-response'
import { OperatorRegistryService } from 'src/operator-registry/operator-registry.service'
import { TasksService } from 'src/tasks/tasks.service'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { differenceInDays, startOfDay, subDays } from 'date-fns'
import { BundlingService } from '../bundling/bundling.service'

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
    geoip.startWatchingDataUpdate()
    this.minHealthyConsensusWeight = config.get<number>('MIN_HEALTHY_CONSENSUS_WEIGHT', { infer: true })

    this.logger.log(
      `Initializing distribution service (IS_LIVE: ${this.isLive})`
    )
  }

  public groupScoreJobs(data: ScoreData[]): ScoreData[][] {
    const result = data.reduce<ScoreData[][]>((curr, score): ScoreData[][] => {
      if (curr.length == 0) {
        curr.push([score])
      } else {
        if (curr[curr.length - 1].length < DistributionService.scoresPerBatch) {
          const last = curr.pop()
          if (last != undefined) {
            last.push(score)
            curr.push(last)
          } else {
            this.logger.error('Last element not found, this should not happen')
          }
        } else {
          curr.push([score])
        }
      }
      return curr
    }, [])

    this.logger.debug(`Created ${result.length} groups out of ${data.length}`)

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
    const stakingData = await this.stakingRewardsService.getStakingData()
    const operatorRegistryState = await this.operatorRegistryService.getOperatorRegistryState()
    const verificationData = operatorRegistryState.VerifiedFingerprintsToOperatorAddresses
    
    const data: { [key: string]: {
      expected: number,
      running: number,
      found: number
    }} = {}

    Object.keys(verificationData).forEach(fingerprint => {
      const verifiedAddress = verificationData[fingerprint]
      
      if (!data[verifiedAddress]) {
        data[verifiedAddress] = {
          expected: 0,
          running: 0,
          found: 0
        }
      }

      data[verifiedAddress].expected++
    })
    
    relaysData.forEach(relay => {
      const verifiedAddress = verificationData[relay.fingerprint]
      if (verifiedAddress && verifiedAddress.length > 0) {
        data[verifiedAddress].found++
        if (relay.running && relay.consensus_weight > this.minHealthyConsensusWeight) {
          data[verifiedAddress].running++
        }
      } else {
        // this.logger.debug(`Found unverified relay ${relay.fingerprint}`)
      }
    })

    const scores = []

    Object.keys(data).forEach(hodler => {
      const hodlerData = data[hodler]
      Object.keys(hodlerData).forEach(operator => {
        const runningShare = Math.max(0, Math.min(hodlerData.running / hodlerData.expected, 1))
        const staked = stakingData[hodler][operator] ?? '0'
        scores.push({
          Hodler: hodler,
          Operator: operator,
          Running: runningShare,
          Staked: staked
        })
      })
    })

    return scores
  }

  public async addScores(stamp: number, scores: ScoreData[]): Promise<boolean> {
    const scoresForLua: AddScoresData = {}
    scores.forEach(score => {
      scoresForLua[score.Hodler][score.Operator] = {
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
        this.logger.warn(`NOT LIVE: Not storing distribution/summary [${snapshot.Timestamp}]`)

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

      this.logger.log(`Permanently stored distribution/summary [${stamp}]: ${summary_tx}`)
      this.tasksService.updateDistribution(stamp, true, true)
      return true
    } catch (error) {
      this.logger.error(`Exception in distribution service persisting round: ${error.message}`, error.stack)
    }

    return false
  }
}
