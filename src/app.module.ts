import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { TasksModule } from './tasks/tasks.module'
import { MongooseModule } from '@nestjs/mongoose'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { DistributionModule } from './distribution/distribution.module'
import { BullModule } from '@nestjs/bullmq'
import { ClusterModule } from './cluster/cluster.module'
import { RelayRewardsModule } from './staking-rewards/staking-rewards.module'
import { OperatorRegistryModule } from './operator-registry/operator-registry.module'
import { BundlingModule } from './bundling/bundling.module'

@Module({
  imports: [
    TasksModule,
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService<{ MONGO_URI: string }>],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGO_URI', { infer: true }),
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<{
          REDIS_HOSTNAME: string
          REDIS_PORT: number
        }>
      ) => ({
        connection: {
          host: config.get<string>('REDIS_HOSTNAME', { infer: true }),
          port: config.get<number>('REDIS_PORT', { infer: true }),
        },
      }),
    }),
    BundlingModule,
    DistributionModule,
    ClusterModule,
    RelayRewardsModule,
    OperatorRegistryModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
