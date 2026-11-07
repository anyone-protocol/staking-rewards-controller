jest.mock('src/staking-rewards/staking-rewards.service', () => ({ StakingRewardsService: class {} }), { virtual: true })
jest.mock('src/operator-registry/operator-registry.service', () => ({ OperatorRegistryService: class {} }), { virtual: true })
jest.mock('src/tasks/tasks.service', () => ({ TasksService: class {} }), { virtual: true })
jest.mock('../bundling/bundling.service', () => ({ BundlingService: class {} }))

import { Logger } from '@nestjs/common'
import { ethers } from 'ethers'
import { of, throwError } from 'rxjs'
import { DistributionService } from './distribution.service'

const OPERATOR = ethers.getAddress('0x' + '1'.repeat(40))
const HODLER = '0x' + '2'.repeat(40)
const FINGERPRINT = 'A'.repeat(40)

function build(response: () => any) {
  const settings = {
    IS_LIVE: 'true',
    ONIONOO_DETAILS_URI: 'http://onionoo.test/details',
    MIN_HEALTHY_CONSENSUS_WEIGHT: 50,
  }
  const config = { get: (key: string) => settings[key] }
  const stakingRewards = {
    getHodlerData: jest.fn(async () => ({
      stakingData: { [OPERATOR]: { [HODLER]: '100' } },
      locksData: { [FINGERPRINT]: [OPERATOR] },
      locksCount: {},
    })),
  }
  const operatorRegistry = {
    getOperatorRegistryScoring: jest.fn(async () => ({
      verified: { [FINGERPRINT]: OPERATOR },
      hardware: {},
    })),
  }
  const http = { get: jest.fn(response) }
  const bundling = { upload: jest.fn(async () => ({ id: 'snapshot-tx' })) }
  const service = new DistributionService(
    config as any,
    stakingRewards as any,
    operatorRegistry as any,
    http as any,
    {} as any,
    bundling as any
  )
  return { service, bundling }
}

const relay = (running: boolean) => ({ fingerprint: FINGERPRINT, running, consensus_weight: 100 })

describe('DistributionService round guards', () => {
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

  it('skips the round and raises an alarm when the onionoo request fails', async () => {
    const { service, bundling } = build(() =>
      throwError(() => Object.assign(new Error('timeout of 60000ms exceeded'), { response: undefined }))
    )

    await expect(service.getCurrentScores(1)).rejects.toThrow('Onionoo fetch failed')
    expect(alarmed('onionoo-fetch-failed')).toBe(true)
    expect(bundling.upload).not.toHaveBeenCalled()
  })

  it('treats an empty relay list as a failed fetch', async () => {
    const { service, bundling } = build(() => of({ status: 200, data: { relays: [] }, headers: {} }))

    await expect(service.getCurrentScores(1)).rejects.toThrow('Onionoo fetch failed')
    expect(alarmed('onionoo-fetch-failed')).toBe(true)
    expect(bundling.upload).not.toHaveBeenCalled()
  })

  it('skips a round where no operator has a running relay', async () => {
    const { service, bundling } = build(() => of({ status: 200, data: { relays: [relay(false)] }, headers: {} }))

    await expect(service.getCurrentScores(1)).rejects.toThrow('Zero-score round')
    expect(alarmed('zero-score-round')).toBe(true)
    expect(bundling.upload).not.toHaveBeenCalled()
  })

  it('scores a round with a running relay', async () => {
    const { service, bundling } = build(() => of({ status: 200, data: { relays: [relay(true)] }, headers: {} }))

    const { scores } = await service.getCurrentScores(1)
    expect(scores).toEqual([{ Hodler: HODLER, Operator: OPERATOR, Running: 1, Staked: '100' }])
    expect(bundling.upload).toHaveBeenCalledTimes(1)
    expect(errors).not.toHaveBeenCalled()
  })
})
