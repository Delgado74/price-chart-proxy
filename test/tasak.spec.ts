import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { buildSeries, parseTrades } from '../src/tasak'
import { KVData, Periods } from '../src/types'

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    price_chart_proxy_kv: KVNamespace
    TASAK_URL: string
  }
}

const TASAK_HOST = 'https://tasak.example.org'

const mockTasak = (status: number, body: string) => {
  fetchMock.get(TASAK_HOST).intercept({ path: '/api/history.json' }).reply(status, body)
}

const makeRequest = async (path: string) => {
  const request = new Request(`http://example.com${path}`)
  const ctx = createExecutionContext()
  const response = await worker.fetch(request as any, env, ctx)
  return { response, ctx }
}

beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})

afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
})

describe('parseTrades', () => {
  it('keeps valid points, defaults a missing size and sorts by time', () => {
    const trades = parseTrades({
      when: 1,
      from: 'tasak',
      data: [
        { time: 300, value: 3 },
        { time: 100, value: 1, size: 10 },
        { time: 200, value: 2, size: 0 },
      ],
    })
    expect(trades).toEqual([
      { time: 100, value: 1, size: 10 },
      { time: 200, value: 2, size: 1 },
      { time: 300, value: 3, size: 1 },
    ])
  })

  it('drops non-finite and non-positive points', () => {
    const trades = parseTrades({
      data: [
        { time: 1, value: 0 },
        { time: 2, value: -5 },
        { time: 0, value: 10 },
        { time: 3, value: 10 },
      ],
    })
    expect(trades).toEqual([{ time: 3, value: 10, size: 1 }])
  })

  it('throws on a malformed payload', () => {
    expect(() => parseTrades(null)).toThrow()
    expect(() => parseTrades({})).toThrow()
    expect(() => parseTrades({ data: 'nope' })).toThrow()
  })
})

describe('buildSeries', () => {
  const now = 1_700_000_000
  const hour = 3600
  const firstBucket = Math.floor((now - 24 * hour) / hour) * hour
  const lastBucket = Math.floor(now / hour) * hour
  const buckets = (lastBucket - firstBucket) / hour + 1

  it('returns nothing without trades', () => {
    expect(buildSeries([], Periods.oneDay, now)).toEqual([])
  })

  it('averages the trades of a bucket weighted by size', () => {
    const at = firstBucket + 5 * hour
    const points = buildSeries(
      [
        { time: at, value: 100, size: 1 },
        { time: at + 60, value: 200, size: 3 },
      ],
      Periods.oneDay,
      now,
    )
    expect(points[0]).toEqual({ time: at, value: 175 })
  })

  it('forward-fills buckets without trades up to the current one', () => {
    const at = firstBucket + 5 * hour
    const points = buildSeries([{ time: at, value: 42, size: 1 }], Periods.oneDay, now)
    expect(points[0]).toEqual({ time: at, value: 42 })
    expect(points.at(-1)).toEqual({ time: lastBucket, value: 42 })
    expect(points).toHaveLength(buckets - 5)
    expect(points.every((point) => point.value === 42)).toBe(true)
  })

  it('anchors a window with no trades at the last known price', () => {
    const old = firstBucket - 10 * hour
    const points = buildSeries([{ time: old, value: 55, size: 1 }], Periods.oneDay, now)
    expect(points).toHaveLength(buckets)
    expect(points.every((point) => point.value === 55)).toBe(true)
  })

  it('starts at the first trade for the all period', () => {
    const first = 1_600_000_000
    const points = buildSeries([{ time: first, value: 7, size: 1 }], Periods.all, now)
    expect(points[0].time).toBe(Math.floor(first / (24 * hour)) * (24 * hour))
    expect(points.at(-1)!.time).toBe(Math.floor(now / (24 * hour)) * (24 * hour))
    expect(points.every((point) => point.value === 7)).toBe(true)
  })
})

describe('CUP through the worker', () => {
  it('serves the tasak series and caches it', async () => {
    const trade = { time: Math.floor(Date.now() / 1000) - 60, value: 63800922.56, size: 100 }
    mockTasak(200, JSON.stringify({ when: trade.time, from: 'tasak', data: [trade] }))
    const { response, ctx } = await makeRequest('/?period=oneDay&fiat=CUP')
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(200)
    const body = (await response.json()) as KVData
    expect(body.from).toBe('tasak')
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data.at(-1)!.value).toBe(trade.value)
    expect(await env.price_chart_proxy_kv.get('oneDay-CUP')).not.toBeNull()
  })

  it('returns 500 when tasak fails and nothing is cached', async () => {
    mockTasak(500, 'Internal Server Error')
    const { response, ctx } = await makeRequest('/?period=oneDay&fiat=CUP')
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects a malformed tasak payload', async () => {
    mockTasak(200, JSON.stringify({ data: 'nope' }))
    const { response, ctx } = await makeRequest('/?period=oneWeek&fiat=CUP')
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(500)
  })
})
