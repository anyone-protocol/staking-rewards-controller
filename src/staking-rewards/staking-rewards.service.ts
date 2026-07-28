import { Injectable, Logger } from '@nestjs/common'
import { ethers, Wallet } from 'ethers'
import _ from 'lodash'
import { EthereumSigner } from '@dha-team/arbundles'
import {
  AoClient,
  AoContractError,
  createAoClient,
  nodeUrlFromEnv
} from '@anyone-protocol/ao-client'
import { ConfigService } from '@nestjs/config'
import { AddScoresData } from 'src/distribution/dto/add-scores'
import RoundSnapshot from 'src/distribution/dto/round-snapshot'
import { hodlerABI } from './abi/hodler'

@Injectable()
export class StakingRewardsService {
  private readonly logger = new Logger(StakingRewardsService.name)

  private isLive?: string

  private readonly stakingRewardsProcessId: string
  private readonly stakingRewardsControllerKey: string
  private readonly hodlerContract: ethers.Contract
  private readonly hbUrl: string

  private ao!: AoClient

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      STAKING_REWARDS_PROCESS_ID: string
      STAKING_REWARDS_CONTROLLER_KEY: string
      HODLER_CONTRACT_ADDRESS: string
      EVM_JSON_RPC: string
      HB_URL: string
    }>
  ) {
    this.isLive = config.get<string>('IS_LIVE', { infer: true })

    this.logger.log(`Initializing staking rewards service (IS_LIVE: ${this.isLive})`)
    const jsonRpc = this.config.get<string>('EVM_JSON_RPC', { infer: true })
    if (!jsonRpc) {
      this.logger.error('Missing EVM JSON RPC URL')
      throw new Error('Missing EVM JSON RPC URL')
    }
    const provider = new ethers.JsonRpcProvider(jsonRpc)
    
    const hodlerAddress = this.config.get<string>('HODLER_CONTRACT_ADDRESS', { infer: true })
    this.hodlerContract =  new ethers.Contract(
        hodlerAddress,
        hodlerABI,
        provider
      )
    
    if (!this.hodlerContract) {
      this.logger.error('Failed to initialize HODLER contract')
    } else this.logger.log(`HODLER contract initialized at address: ${hodlerAddress}`)

    const stakingRewardsPid = this.config.get<string>('STAKING_REWARDS_PROCESS_ID', {
      infer: true,
    })
    if (stakingRewardsPid != undefined) {
      this.stakingRewardsProcessId = stakingRewardsPid
    } else this.logger.error('Missing staking rewards process id')

    const stakingRewardsKey = this.config.get<string>('STAKING_REWARDS_CONTROLLER_KEY', {
      infer: true,
    })

    if (stakingRewardsKey != undefined) {
      this.stakingRewardsControllerKey = stakingRewardsKey
    } else this.logger.error('Missing staking rewards controller key')

    // Fail closed, no default. Replaces CU_URL.
    this.hbUrl = nodeUrlFromEnv({
      HB_URL: this.config.get<string>('HB_URL', { infer: true })
    })
  }

  async onApplicationBootstrap(): Promise<void> {
    this.ao = createAoClient({
      url: this.hbUrl,
      signer: new EthereumSigner(this.stakingRewardsControllerKey),
      logger: {
        debug: (m, ...meta) => this.logger.debug(m, ...meta),
        warn: (m, ...meta) => this.logger.warn(m, ...meta),
        error: (m, ...meta) => this.logger.error(m, ...meta)
      }
    })
    const wallet = new Wallet(this.stakingRewardsControllerKey)
    const address = await wallet.getAddress()
    this.logger.log(`Bootstrapped with signer address ${address} against node ${this.hbUrl}`)

    // Surface an unreachable node at boot rather than mid-round. Warn, do not throw: a blip
    // during a rolling deploy should not crash-loop the service.
    try {
      this.logger.log(`Node operator address: ${await this.ao.fetchNodeAddress()}`)
    } catch (error) {
      this.logger.warn(
        `Could not reach the HyperBEAM node at ${this.hbUrl} during bootstrap`,
        error.stack
      )
    }
  }

  public async getHodlerData(): Promise<{
    locksData: { [key: string]: string[] },
    stakingData: { [key: string]: { [key: string]: string }},
    locksCount: { [key: string]: { [key: string]: number }}
  }> {
    const locksData = {}
    const stakingData = {}
    const locksCount = {}

    const keys = await this.hodlerContract.getHodlerKeys()
    for (const key of keys) {
      const hodlerAddress = ethers.getAddress(key)

      const locks: { fingerprint: string, operator: string, amount: string }[] = await this.hodlerContract.getLocks(hodlerAddress)
      locks.forEach((lock) => {
        if (!locksData[lock.fingerprint]) {
          locksData[lock.fingerprint] = []
        }
        const operatorAddress = ethers.getAddress(lock.operator)
        if (!locksData[lock.fingerprint].includes(operatorAddress)) {
          locksData[lock.fingerprint].push(operatorAddress)
        }
        if (!locksCount[operatorAddress]) {
          locksCount[operatorAddress] = {}
        }
        locksCount[operatorAddress][lock.fingerprint] = (locksCount[operatorAddress][lock.fingerprint] || 0) + 1
      })

      const stakes: { operator: string, amount: string }[] = await this.hodlerContract.getStakes(hodlerAddress)
      stakes.forEach((stake) => {
        const operatorAddress = ethers.getAddress(stake.operator)
        if (operatorAddress && operatorAddress.length > 0) {
          if (!stakingData[operatorAddress]) {
            stakingData[operatorAddress] = {}
          }
          stakingData[operatorAddress][hodlerAddress] = BigInt(stake.amount).toString()
        }
      })
      this.logger.debug(`Fetched staking data [${stakes.length}] for hodler ${hodlerAddress}`)
    }
    this.logger.log(`Fetched staking data for ${Object.keys(stakingData).length} operators`)

    return { stakingData, locksData, locksCount }
  }

  /**
   * The completed round's full snapshot — Timestamp, Period, Summary, Configuration and the
   * per-hodler `Details`.
   *
   * This was a `Last-Snapshot` dryrun; the native contract serves it as the `last_snapshot`
   * view, which returns `PreviousRound` verbatim.
   *
   * NB this differs from relay-rewards, whose snapshot must be read from the Complete-Round
   * SETTLE SLOT: relay deliberately does not persist its per-fingerprint Details (~3.6MB a
   * round, 9750 entries). Staking's Details are per-HODLER and small enough to keep in state,
   * so the round survives in `PreviousRound` and a plain view read is enough. Do not
   * "harmonize" these two — the difference is in the contracts, not the clients.
   */
  public async getLastSnapshot(): Promise<RoundSnapshot | undefined> {
    try {
      return await this.ao.readView<RoundSnapshot>(
        this.stakingRewardsProcessId,
        'last_snapshot'
      )
    } catch (error) {
      this.logger.error(`Exception in getLastSnapshot: ${error.message}`, error.stack)
    }
  }

  public async addScores(stamp: number, scores: AddScoresData): Promise<boolean> {
    if (this.isLive !== 'true') {
      this.logger.warn(`NOT LIVE: Not adding ${scores.length} scores to distribution contract `)

      return false
    }

    try {
      const { id } = await this.ao.sendMessage({
        processId: this.stakingRewardsProcessId,
        action: 'Add-Scores',
        // Tag names must be lowercase for the ans104 signature round-trip; the node
        // presents them title-cased to the contract (`ctx.tags['Round-Timestamp']`).
        tags: [{ name: 'round-timestamp', value: stamp.toString() }],
        data: JSON.stringify({ Scores: scores })
      })

      this.logger.log(
        `[${stamp}] Add-Scores for ${Object.keys(scores).length} hodlers: ${id}`
      )

      return true
    } catch (error) {
      if (error instanceof AoContractError) {
        this.logger.error(
          `Failed storing ${Object.keys(scores).length} scores for ${stamp}: ${error.reason}`
        )
      } else {
        this.logger.error(`Exception in addScores: ${error.message}`, error.stack)
      }
    }

    return false
  }

  public async completeRound(stamp: number): Promise<boolean> {
    if (this.isLive !== 'true') {
      this.logger.warn(`NOT LIVE: Not sending the Complete-Round message`)

      return false
    }

    try {
      this.logger.log(`Completing round for ${stamp}...`)
      const { id } = await this.ao.sendMessage({
        processId: this.stakingRewardsProcessId,
        action: 'Complete-Round',
        tags: [{ name: 'round-timestamp', value: stamp.toString() }]
      })

      this.logger.log(`[${stamp}] Complete-Round: ${id}`)

      return true
    } catch (error) {
      if (error instanceof AoContractError) {
        this.logger.error(`Failed Complete-Round for ${stamp}: ${error.reason}`)
      } else {
        this.logger.error(`Exception in completeRound: ${error.message}`, error.stack)
      }
    }

    return false
  }
}
