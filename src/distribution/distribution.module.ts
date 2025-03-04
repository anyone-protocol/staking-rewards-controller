import { forwardRef, Logger, Module } from '@nestjs/common'
import { DistributionService } from './distribution.service'
import { ConfigModule } from '@nestjs/config'
import { StakingRewardsModule } from 'src/staking-rewards/staking-rewards.module'
import { OperatorRegistryModule } from 'src/operator-registry/operator-registry.module'
import { HttpModule } from '@nestjs/axios'
import { TasksModule } from 'src/tasks/tasks.module'
import { BundlingModule } from 'src/bundling/bundling.module'

@Module({
  imports: [
    ConfigModule, 
    StakingRewardsModule, 
    OperatorRegistryModule, 
    HttpModule, 
    BundlingModule, 
    forwardRef(() => TasksModule)
  ],
  providers: [DistributionService, Logger],
  exports: [DistributionService],
})
export class DistributionModule {}
