import { Inject, Injectable, Logger, LoggerService, } from '@nestjs/common'
import { AosSigningFunction, sendAosMessage } from '../util/send-aos-message'
import { createEthereumDataItemSigner } from '../util/create-ethereum-data-item-signer'
import { ethers, Wallet } from 'ethers'
import _ from 'lodash'
import { EthereumSigner } from '../util/arbundles-lite'
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

  private signer!: AosSigningFunction

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      STAKING_REWARDS_PROCESS_ID: string
      STAKING_REWARDS_CONTROLLER_KEY: string
      HODLER_CONTRACT_ADDRESS: string
      EVM_JSON_RPC: string
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
  }

  async onApplicationBootstrap(): Promise<void> {
    this.signer = await createEthereumDataItemSigner(new EthereumSigner(this.stakingRewardsControllerKey))
    const wallet = new Wallet(this.stakingRewardsControllerKey)
    const address = await wallet.getAddress()
    this.logger.log(`Bootstrapped with signer address ${address}`)
  }

  public async getHodlerData(): Promise<{
    locksData: { [key: string]: string[] },
    stakingData: { [key: string]: { [key: string]: number }}
  }> {
    const locksData = {}
    const stakingData = {}

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
      })

      const stakes: { operator: string, amount: string }[] = await this.hodlerContract.getStakes(hodlerAddress)
      stakes.forEach((stake) => {
        const operatorAddress = ethers.getAddress(stake.operator)
        if (operatorAddress && operatorAddress.length > 0) {
          if (!stakingData[operatorAddress]) {
            stakingData[operatorAddress] = {}
          }
          stakingData[operatorAddress][hodlerAddress] = stake.amount
        }
      })
      this.logger.log(`Fetched staking data [${stakes.length}] for hodler ${hodlerAddress}`)
    }
    this.logger.log(`Fetched staking data for ${Object.keys(stakingData).length} operators`)

    return { stakingData, locksData }
  }

  public async getLastSnapshot(): Promise<RoundSnapshot | undefined> {
    try {
      const { result } = await sendAosMessage({
        processId: this.stakingRewardsProcessId,
        signer: this.signer as any, // NB: types, lol
        tags: [
          { name: 'Action', value: 'Last-Snapshot' },
          { name: 'Timestamp', value: Date.now().toString() },
        ],
      })

      if (!result.Error) {
        const data: RoundSnapshot = JSON.parse(result.Messages[0].Data)

        return data
      } else {
        this.logger.error(`Failed fetching Last-Snapshot: ${result.Error}`)
      }
    } catch (error) {
      this.logger.error(`Exception in getLastSnapshot: ${error.message}`, error.stack)
    }
  }

  public async addScores(stamp: number, scores: AddScoresData): Promise<boolean> {
    if (this.isLive === 'true') {
      try {
        const { messageId, result } = await sendAosMessage({
          processId: this.stakingRewardsProcessId,
          signer: this.signer as any, // NB: types, lol
          tags: [
            { name: 'Action', value: 'Add-Scores' },
            { name: 'Timestamp', value: stamp.toString() },
          ],
          data: JSON.stringify({
            Scores: scores,
          }),
        })

        if (!result.Error) {
          this.logger.log(`[${stamp}] Add-Scores ${Object.keys(scores).length}: ${messageId ?? 'no-message-id'}`)

          return true
        } else {
          this.logger.error(`Failed storing ${Object.keys(scores).length} scores for ${stamp}: ${result.Error}`)
        }
      } catch (error) {
        this.logger.error(`Exception in addScores: ${error.message}`, error.stack)
      }
    } else {
      this.logger.warn(`NOT LIVE: Not adding ${scores.length} scores to distribution contract `)
    }

    return false
  }

  public async completeRound(stamp: number): Promise<boolean> {
    if (this.isLive !== 'true') {
      this.logger.warn(`NOT LIVE: Not sending the Complete-Round message`)

      return false
    }

    try {
      const { messageId, result } = await sendAosMessage({
        processId: this.stakingRewardsProcessId,
        signer: this.signer as any, // NB: types, lol
        tags: [
          { name: 'Action', value: 'Complete-Round' },
          { name: 'Timestamp', value: stamp.toString() },
        ],
      })

      if (!result.Error) {
        this.logger.log(`[${stamp}] Complete-Round: ${messageId ?? 'no-message-id'}`)

        return true
      } else {
        this.logger.error(`Failed Complete-Round for ${stamp}: ${result.Error}`)
      }
    } catch (error) {
      this.logger.error(`Exception in distribute: ${error.message}`, error.stack)
    }
    return false
  }
}
