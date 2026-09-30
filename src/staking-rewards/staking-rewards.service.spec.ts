/**
 * INTEGRATION test — talks to a real HyperBEAM node holding a real staking-rewards process.
 *
 * Requires:
 *   HB_URL                            e.g. http://localhost:8734
 *   STAKING_REWARDS_PROCESS_ID        a process spawned from a staking-rewards module
 *   STAKING_REWARDS_CONTROLLER_KEY    an EVM key holding owner/admin on that process
 *   IS_LIVE=true                      the write paths no-op otherwise, by design
 *   EVM_JSON_RPC, HODLER_CONTRACT_ADDRESS
 *                                     the constructor hard-requires these (unlike
 *                                     relay-rewards, which gates them behind USE_HODLER).
 *                                     Nothing here calls getHodlerData, so placeholders are
 *                                     fine — ethers does not dial on construction.
 *
 * To stand one up locally see smart-contracts/ao/scripts/run-e2e.ts.
 */
import { Logger } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { Test, TestingModule } from '@nestjs/testing'

import { StakingRewardsService } from './staking-rewards.service'

const HAVE_NODE = !!process.env.STAKING_REWARDS_PROCESS_ID && !!process.env.HB_URL
const itNode = HAVE_NODE ? it : it.skip

describe('StakingRewardsService', () => {
  let module: TestingModule
  let service: StakingRewardsService

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [StakingRewardsService]
    })
      .setLogger(new Logger())
      .compile()
    service = module.get<StakingRewardsService>(StakingRewardsService)
    await service.onApplicationBootstrap()
  })

  afterEach(async () => {
    await module.close()
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })

  itNode('settles a round and reads it back from the last_snapshot view', async () => {
    // A round must be newer than the seeded PreviousRound, so derive the stamp from the
    // contract rather than the wall clock.
    const status: any = await (service as any).ao.readView(
      process.env.STAKING_REWARDS_PROCESS_ID,
      'status'
    )
    const stamp = Number(status.lastRoundTimestamp) + 3_600_000

    const hodler = '0x' + '2'.repeat(40)
    const operator = '0x' + '3'.repeat(40)
    const added = await service.addScores(stamp, {
      [hodler]: { [operator]: { Staked: (1000n * 10n ** 18n).toString(), Running: 1 } }
    } as any)
    expect(added).toBe(true)

    expect(await service.completeRound(stamp)).toBe(true)

    const snapshot = await service.getLastSnapshot()
    expect(snapshot).toBeDefined()
    expect(Number(snapshot!.Timestamp)).toBe(stamp)
    expect(Number(snapshot!.Period)).toBeGreaterThan(0)
    expect(snapshot!.Configuration).toBeDefined()
    expect(snapshot!.Summary?.Rewards).toBeDefined()

    // Unlike relay-rewards, staking PERSISTS Details, which is why this is a plain view read
    // and not a settle-slot read. If that ever changes, this assertion is the tripwire.
    expect(snapshot!.Details).toBeDefined()
    expect(snapshot!.Details[hodler]).toBeDefined()
  }, 300_000)

  itNode('reports a round it did not settle rather than guessing', async () => {
    const status: any = await (service as any).ao.readView(
      process.env.STAKING_REWARDS_PROCESS_ID,
      'status'
    )
    const stale = Number(status.lastRoundTimestamp)

    expect(await service.completeRound(stale)).toBe(false)
  }, 180_000)
})
