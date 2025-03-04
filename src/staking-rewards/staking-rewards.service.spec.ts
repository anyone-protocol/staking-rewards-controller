import { Test, TestingModule } from '@nestjs/testing'
import { StakingRewardsService } from './staking-rewards.service'

describe('StakingRewardsService', () => {
  let service: StakingRewardsService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [StakingRewardsService],
    }).compile()

    service = module.get<StakingRewardsService>(StakingRewardsService)
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })
})
