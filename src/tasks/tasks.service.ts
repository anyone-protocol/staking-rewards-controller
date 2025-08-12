import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { InjectQueue, InjectFlowProducer } from '@nestjs/bullmq'
import { Queue, FlowProducer, FlowJob } from 'bullmq'
import { ScoreData } from '../distribution/schemas/score-data'
import { ConfigService } from '@nestjs/config'
import { ClusterService } from '../cluster/cluster.service'
import { InjectModel } from '@nestjs/mongoose'
import { TaskServiceData } from './schemas/task-service-data'
import { Model } from 'mongoose'

@Injectable()
export class TasksService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TasksService.name)

  private doClean?: string

  static readonly removeOnComplete = true
  static readonly removeOnFail = 8

  public minRoundLength = 1000 * 60

  public static jobOpts = {
    removeOnComplete: TasksService.removeOnComplete,
    removeOnFail: TasksService.removeOnFail,
  }

  public static DISTRIBUTION_FLOW({
    stamp,
    total,
    scoreGroups,
  }: {
    stamp: number
    total: number
    scoreGroups: ScoreData[][]
  }): FlowJob {
    return {
      name: 'persist-last-round',
      queueName: 'distribution-queue',
      opts: TasksService.jobOpts,
      data: { stamp },
      children: [
        {
          name: 'complete-round',
          queueName: 'distribution-queue',
          opts: TasksService.jobOpts,
          data: { stamp, total },
          children: scoreGroups.map((scores, index, array) => ({
            name: 'add-scores',
            queueName: 'distribution-queue',
            opts: TasksService.jobOpts,
            data: { stamp, scores },
          })),
        },
      ],
    }
  }

  constructor(
    private readonly config: ConfigService<{
      IS_LIVE: string
      DO_CLEAN: string
      VERSION: string
      ROUND_PERIOD_SECONDS: number
    }>,
    private readonly cluster: ClusterService,
    @InjectQueue('tasks-queue')
    public tasksQueue: Queue,
    @InjectQueue('distribution-queue')
    public distributionQueue: Queue,
    @InjectFlowProducer('distribution-flow')
    public distributionFlow: FlowProducer,
    @InjectModel(TaskServiceData.name)
    private readonly taskServiceDataModel: Model<TaskServiceData>
  ) {
    this.doClean = this.config.get<string>('DO_CLEAN', { infer: true })
    const minRound: number = this.config.get<number>('ROUND_PERIOD_SECONDS', {
      infer: true,
    })
    if (minRound > 0) this.minRoundLength = minRound * 1000
    const version = this.config.get<string>('VERSION', { infer: true })
    this.logger.log(`Starting Tasks service for Staking Rewards Controller version: ${version}`)
  }

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Bootstrapping Tasks Service')

    if (this.cluster.isTheOne()) {
      this.logger.log(
        `I am the leader, checking queue cleanup & immediate queue start`
      )
      if (this.doClean == 'true') {
        this.logger.log(
          'Cleaning up tasks queue, distribution queue, and task service ' +
            'state because DO_CLEAN is true'
        )
        try {
          await this.taskServiceDataModel.deleteMany({})
          await this.tasksQueue.obliterate({ force: true })
          await this.distributionQueue.obliterate({ force: true })
        } catch (error) {
          this.logger.error(
            `Failed cleaning up queues: ${error.message}`,
            error.stack
          )
        }
      }

      const lastData = await this.taskServiceDataModel
        .findOne()
        .sort({ startedAt: -1 })
        .limit(1)
      if (lastData) {
        this.logger.log(
          `Bootstrapped Tasks service with startedAt: ${lastData.startedAt} ` +
            `(complete: ${lastData.complete}, persisted: ${lastData.persisted})`
        )

        return
      } else {
        this.logger.log(
          `Bootstrapping Tasks service with a new distribution queue`
        )

        this.queueDistribution().catch(error => {
          this.logger.error(
            `Failed to queue distribution during bootstrap: ${error.message}`,
            error.stack
          )
        })
      }
    } else {
      this.logger.debug(
        'Not the local leader, skipping bootstrap of tasks service'
      )
    }
  }

  public async updateDistribution(stamp: number, complete: boolean, persisted: boolean): Promise<any> {
    return this.taskServiceDataModel.updateOne({ stamp: stamp }, { complete: complete, persisted: persisted })
  }

  public async queueDistribution(): Promise<void> {
    const lastData = await this.taskServiceDataModel.findOne().sort({ startedAt: -1 }).limit(1)
    const lastStart = lastData ? lastData.startedAt : 0

    const now = Date.now()
    if (now - lastStart >= this.minRoundLength) {
      try {
        await this.distributionQueue.add('start-distribution', now, TasksService.jobOpts)
        await this.taskServiceDataModel.create({ startedAt: now })
      } catch (error) {
        this.logger.error(
          `Failed adding distribution job to queue: ${error.message}`,
          error.stack
        )
      }
    }

    const timeOffset = Math.max(0, this.minRoundLength - (now - lastStart))
    this.logger.log(`Queueing distribution for recheck in ... ${timeOffset / 1000}s`)
    return this.tasksQueue
      .add(
        'queued-distribute',
        {},
        {
          delay: timeOffset,
          removeOnComplete: TasksService.removeOnComplete,
          removeOnFail: TasksService.removeOnFail,
        }
      )
      .then(
        () => {
          this.logger.log('[alarm=enqueued-distribution] Enqueued timed distribution job')
          return
        },
        error => {
          this.logger.error(`Failed adding timed distribution job to queue: ${error.message}`, error.stack)
          return
        }
      )
  }
}
