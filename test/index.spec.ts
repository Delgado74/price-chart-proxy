import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { KVData } from '../src/types'

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    price_chart_proxy_kv: KVNamespace
  }
}

const oneHourMs = 60 * 60 * 1000

// Coinbase candle: [time, low, high, open, close, volume]
const coinbaseCandles = [
  [1717030800, 67000, 68000, 67500, 67900, 10],
  [1717027200, 66000, 67500, 66500, 67400, 12],
]

const cachedData: KVData = {
  data: [{ time: 1717027200, value: 67400 }],
  when: Date.now(),
  from: 'coinbase',
}

const mockCoinbase = (status: number, body: string) => {
  fetchMock
    .get('https://api.exchange.coinbase.com')
    .intercept({ path: /^\/products\/BTC-USD\/candles/ })
    .reply(status, body)
}

const mockCoingecko = (status: number, body: string) => {
  fetchMock
    .get('https://api.coingecko.com')
    .intercept({ path: /^\/api\/v3\/coins\/bitcoin\/market_chart/ })
    .reply(status, body)
}

const mockCoinbaseSuccess = () => mockCoinbase(200, JSON.stringify(coinbaseCandles))
const mockCoinbaseFailure = () => mockCoinbase(500, 'Internal Server Error')
const mockCoingeckoRateLimited = () =>
  mockCoingecko(429, JSON.stringify({ status: { error_code: 429, error_message: 'Rate limited' } }))

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

describe('param validation', () => {
  it('returns 400 for an unsupported fiat without calling upstream', async () => {
    const { response } = await makeRequest('/?period=oneYear&fiat=BRL%20Request%20Method')
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('Unsupported fiat')
  })

  it('returns 400 for an unsupported period without calling upstream', async () => {
    const { response } = await makeRequest('/?period=twoCenturies')
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('Unsupported period')
  })
})

describe('cold cache', () => {
  it('fetches upstream, returns data and stores it in KV', async () => {
    mockCoinbaseSuccess()
    const { response, ctx } = await makeRequest('/?period=oneDay&fiat=USD')
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    const body = (await response.json()) as KVData
    expect(body.from).toBe('coinbase')
    expect(body.data).toEqual([
      { time: 1717027200, value: 67400 },
      { time: 1717030800, value: 67900 },
    ])
    const stored = await env.price_chart_proxy_kv.get('oneDay-USD')
    expect(stored).not.toBeNull()
  })

  it('returns 500 with no-store when all providers fail and nothing is cached', async () => {
    mockCoinbaseFailure()
    mockCoingeckoRateLimited()
    const { response, ctx } = await makeRequest('/?period=oneDay&fiat=USD')
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('429')
  })
})

describe('warm cache', () => {
  it('serves fresh cached data without calling upstream', async () => {
    await env.price_chart_proxy_kv.put('oneDay-USD', JSON.stringify(cachedData))
    const { response, ctx } = await makeRequest('/?period=oneDay&fiat=USD')
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(200)
    const body = (await response.json()) as KVData
    expect(body.when).toBe(cachedData.when)
  })

  it('serves stale data immediately and refreshes it in the background', async () => {
    const staleData: KVData = { ...cachedData, when: Date.now() - 2 * oneHourMs }
    await env.price_chart_proxy_kv.put('oneDay-USD', JSON.stringify(staleData))
    mockCoinbaseSuccess()
    const { response, ctx } = await makeRequest('/?period=oneDay&fiat=USD')
    expect(response.status).toBe(200)
    const body = (await response.json()) as KVData
    expect(body.when).toBe(staleData.when) // stale data served without waiting for refresh
    await waitOnExecutionContext(ctx)
    const stored = JSON.parse((await env.price_chart_proxy_kv.get('oneDay-USD'))!) as KVData
    expect(stored.when).toBeGreaterThan(staleData.when) // background refresh updated the cache
    expect(await env.price_chart_proxy_kv.get('lock-oneDay-USD')).not.toBeNull()
  })

  it('keeps serving stale data when upstream providers are rate limited', async () => {
    const staleData: KVData = { ...cachedData, when: Date.now() - 2 * oneHourMs }
    await env.price_chart_proxy_kv.put('oneDay-USD', JSON.stringify(staleData))
    mockCoinbaseFailure()
    mockCoingeckoRateLimited()
    const { response, ctx } = await makeRequest('/?period=oneDay&fiat=USD')
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(200)
    const body = (await response.json()) as KVData
    expect(body.when).toBe(staleData.when)
  })

  it('skips the background refresh when another refresh holds the lock', async () => {
    const staleData: KVData = { ...cachedData, when: Date.now() - 2 * oneHourMs }
    await env.price_chart_proxy_kv.put('oneDay-USD', JSON.stringify(staleData))
    await env.price_chart_proxy_kv.put('lock-oneDay-USD', '1', { expirationTtl: 60 })
    const { response, ctx } = await makeRequest('/?period=oneDay&fiat=USD')
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(200) // no upstream mocks registered: refresh was skipped
    const stored = JSON.parse((await env.price_chart_proxy_kv.get('oneDay-USD'))!) as KVData
    expect(stored.when).toBe(staleData.when)
  })
})
