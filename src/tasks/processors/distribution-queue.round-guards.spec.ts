jest.mock('src/distribution/distribution.service', () => ({ DistributionService: class {} }), { virtual: true })
jest.mock('../tasks.service', () => ({ TasksService: class { static DISTRIBUTION_FLOW = (flow: any) => flow } }))

import { Logger } from '@nestjs/common'
import { DistributionQueue } from './distribution-queue'

describe('DistributionQueue round guards', () => {
  let errors: jest.SpyInstance

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  const alarmed = (name: string) =>
    errors.mock.calls.some(([message]) => String(message).includes(`[alarm=${name}]`))

  it('fails the start job when the round cannot be scored', async () => {
    const distribution = { getCurrentScores: jest.fn(async () => { throw new Error('Onionoo fetch failed: down') }) }
    const tasks = { distributionFlow: { add: jest.fn() } }
    const queue = new DistributionQueue(distribution as any, tasks as any)

    await expect(queue.startDistributionHandler({ data: 1 } as any)).rejects.toThrow('Onionoo fetch failed')
    expect(tasks.distributionFlow.add).not.toHaveBeenCalled()
  })

  it('raises an alarm and does not complete the round when no score is accepted', async () => {
    const distribution = { complete: jest.fn() }
    const queue = new DistributionQueue(distribution as any, {} as any)
    const job = {
      data: { stamp: 1, total: 5 },
      getChildrenValues: async () => ({ batch: { result: false, scored: 5 } }),
    }

    await expect(queue.completeDistributionHandler(job as any)).resolves.toBe(false)
    expect(alarmed('scores-not-accepted')).toBe(true)
    expect(distribution.complete).not.toHaveBeenCalled()
  })

  it('raises an alarm when only some scores are accepted', async () => {
    const distribution = { complete: jest.fn(async () => true) }
    const queue = new DistributionQueue(distribution as any, {} as any)
    const job = {
      data: { stamp: 1, total: 5 },
      getChildrenValues: async () => ({
        first: { result: true, scored: 3 },
        second: { result: false, scored: 2 },
      }),
    }

    await queue.completeDistributionHandler(job as any)
    expect(alarmed('scores-partially-accepted')).toBe(true)
  })
})
