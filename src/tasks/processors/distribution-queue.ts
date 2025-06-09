import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq'
import { Inject, Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { DistributionService } from 'src/distribution/distribution.service'
import { TasksService } from '../tasks.service'
import { ScoreData } from 'src/distribution/schemas/score-data'
import { AddScoresResult } from 'src/distribution/dto/add-scores'

@Processor('distribution-queue')
export class DistributionQueue extends WorkerHost {
  private readonly logger = new Logger(DistributionQueue.name)

  public static readonly JOB_START_DISTRIBUTION = 'start-distribution'
  public static readonly JOB_ADD_SCORES = 'add-scores'
  public static readonly JOB_COMPLETE_ROUND = 'complete-round'
  public static readonly JOB_PERSIST_LAST_ROUND = 'persist-last-round'

  constructor(
    private readonly distribution: DistributionService,
    private readonly tasks: TasksService
  ) {
    super()
  }

  async process(job: Job<any, any, string>): Promise<boolean | AddScoresResult | undefined> {
    this.logger.debug(`Dequeueing ${job.name} [${job.id}]`)

    switch (job.name) {
      case DistributionQueue.JOB_START_DISTRIBUTION:
        return this.startDistributionHandler(job)

      case DistributionQueue.JOB_ADD_SCORES:
        return this.addScoresHandler(job)

      case DistributionQueue.JOB_COMPLETE_ROUND:
        return this.completeDistributionHandler(job)

      case DistributionQueue.JOB_PERSIST_LAST_ROUND:
        return this.persistDistributionHandler(job)

      default:
        this.logger.warn(`Found unknown job ${job.name} [${job.id}]`)
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<any, any, string>) {
    this.logger.debug(`Finished ${job.name} [${job.id}]`)
  }

  async startDistributionHandler(job: Job<number, boolean, string>): Promise<boolean> {
    return this.distribution.getCurrentScores(job.data).then(
      scores => {
        const scoreGroups = this.distribution.groupScoreJobs(scores)

        this.tasks.distributionFlow.add(
          TasksService.DISTRIBUTION_FLOW({
            stamp: job.data,
            total: scores.length,
            scoreGroups: scoreGroups,
          })
        )

        this.logger.log(
          `Starting distribution ${job.data} with ${scores.length} non-zero scores grouped to ${scoreGroups.length} jobs`
        )
        return true
      },
      error => {
        this.logger.error(`Exception while starting distribution: ${error.message}`, error.stack)
        return false
      }
    )
  }

  async addScoresHandler(
    job: Job<{ stamp: number; scores: ScoreData[] }, AddScoresResult, string>
  ): Promise<AddScoresResult> {
    try {
      if (job.data != undefined) {
        this.logger.log(`Adding ${job.data.scores.length} scores for ${job.data.stamp}`)

        return this.distribution.addScores(job.data.stamp, job.data.scores).then(
          result => ({
            result: result,
            stamp: job.data.stamp,
            scored: job.data.scores.length,
          }),
          error => {
            this.logger.error(`Exception while adding scores: ${error.message}`, error.stack)
            return { result: false, stamp: 0, scored: 0 }
          }
        )
      } else {
        this.logger.error('Undefined job data')
      }
    } catch (e) {
      this.logger.error('Exception while adding scores', e.stack)
    }
    return { result: false, stamp: 0, scored: 0 }
  }

  async completeDistributionHandler(job: Job<{ stamp: number; total: number }, boolean, string>): Promise<boolean> {
    try {
      const jobValues = await job.getChildrenValues()
      const jobsData = Object.values(jobValues)
      const { processed, failed } = jobsData.reduce(
        (acc, curr) => {
          if (curr.result) {
            acc.processed++
          } else {
            acc.failed++
          }
          return acc
        },
        { processed: 0, failed: 0 }
      )

      if (processed.length < job.data.total) {
        this.logger.warn(`Processed less score groups (${processed}) then the total found (${job.data.total})`)
      } else if (processed == 0) {
        this.logger.warn(`No scores found to process`)
      } else {
        this.logger.log(`Processed ${processed} score group(s)`)
      }

      if (processed.length > 0) {
        return this.distribution.complete(job.data.stamp)
      } else {
        return false
      }
    } catch (err) {
      this.logger.error(`Exception completing distribution [${job.data.stamp}]`, err.stack)
    }
  }

  async persistDistributionHandler(job: Job<{ stamp: number }, boolean, string>): Promise<boolean> {
    try {
      const isComplete = Object.values(await job.getChildrenValues())[0] ?? false
      if (!isComplete) {
        this.logger.warn(
          `Round was not marked as complete. Skipping persisting of distribution summary [${job.data.stamp}]`
        )
        return false
      }
      this.logger.log(`Persisting distribution summary [${job.data.stamp}]`)
      return this.distribution.persistRound(job.data.stamp)
    } catch (err) {
      this.logger.error(`Exception persisting distribution summary [${job.data.stamp}]`, err.stack)
    }

    return false
  }
}
