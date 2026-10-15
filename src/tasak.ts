import { Env, Fiats, LivelineData, LivelinePoint, Periods } from './types'

/**
 * BTC/CUP historical series sourced from a tasak instance.
 *
 * Coinbase and Coingecko have no BTC/CUP pair, so this provider reads the P2P
 * trade archive of a tasak deployment instead: every completed Mostro order is
 * a signed Nostr event (publicly verifiable) and tasak serves the whole series
 * as static JSON at `{TASAK_URL}/api/history.json`:
 *
 *   { "when": 1760000000, "from": "tasak",
 *     "data": [{ "time": 1759999000, "value": 63800922.56, "size": 1200 }] }
 *
 * `time` is the unix seconds of the order, `value` the CUP per BTC it traded at
 * and `size` the CUP amount it moved (used to weight the buckets). Because the
 * series already exists in the archive there is no accumulation delay: `all`
 * covers everything the instance has archived.
 */

// A single archived P2P trade as served by tasak.
type TasakTrade = {
  time: number
  value: number
  size: number
}

// Bucket size (seconds) per period, following Coinbase's granularity convention.
const bucketSecs: Record<Periods, number> = {
  [Periods.oneHour]: 5 * 60,
  [Periods.oneDay]: 60 * 60,
  [Periods.oneWeek]: 6 * 60 * 60,
  [Periods.oneMonth]: 24 * 60 * 60,
  [Periods.oneYear]: 24 * 60 * 60,
  [Periods.all]: 24 * 60 * 60,
}

// How far back the returned points reach, in seconds (-1 = all archived trades).
const windowSecs: Record<Periods, number> = {
  [Periods.oneHour]: 60 * 60,
  [Periods.oneDay]: 24 * 60 * 60,
  [Periods.oneWeek]: 7 * 24 * 60 * 60,
  [Periods.oneMonth]: 30 * 24 * 60 * 60,
  [Periods.oneYear]: 365 * 24 * 60 * 60,
  [Periods.all]: -1,
}

/**
 * Whether this provider serves the given fiat. Only CUP is backed by tasak;
 * every other currency keeps the Coinbase/Coingecko path.
 */
export const isSupportedFiat = (fiat: string): fiat is Fiats => fiat === Fiats.CUP

/**
 * Validates and normalizes the tasak payload into a sorted list of trades.
 * Throws on a malformed payload so a bad response is never cached; individual
 * points that are not finite/positive are dropped.
 * @param payload The parsed JSON returned by the tasak instance.
 * @returns The valid trades, oldest first.
 */
export const parseTrades = (payload: unknown): TasakTrade[] => {
  if (payload === null || typeof payload !== 'object') throw new Error('tasak: not an object')
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) throw new Error('tasak: missing data array')
  return data
    .filter((point): point is Record<string, unknown> => point !== null && typeof point === 'object')
    .map((point) => ({
      time: Number(point.time),
      value: Number(point.value),
      // Trades without a usable size still count, just unweighted.
      size: Number(point.size) > 0 ? Number(point.size) : 1,
    }))
    .filter((trade) => Number.isFinite(trade.time) && trade.time > 0 && Number.isFinite(trade.value) && trade.value > 0)
    .sort((a, b) => a.time - b.time)
}

/**
 * Bucketizes trades into a volume-weighted series for a period. Each bucket
 * holds the VWAP of the trades that fall in it; buckets without trades repeat
 * the previous value (forward-fill) so the line stays continuous, and the
 * series is anchored at the start of the window so windows with no trades at
 * all still show the last known price. Returns [] when there is nothing to show.
 * @param trades The trades, oldest first.
 * @param period The requested period.
 * @param now Current unix seconds (the end of the window).
 * @returns The Liveline points, oldest first.
 */
export const buildSeries = (trades: TasakTrade[], period: Periods, now: number): LivelineData => {
  if (trades.length === 0) return []
  const bucket = bucketSecs[period]
  const window = windowSecs[period]
  // `all` starts at the first trade; the rest start a fixed window before now.
  const start = window > 0 ? now - window : trades[0].time

  // Value to forward-fill the leading buckets: the last trade at or before start.
  let last: number | null = null
  for (const trade of trades) {
    if (trade.time <= start) last = trade.value
    else break
  }

  const firstBucket = Math.floor(start / bucket) * bucket
  const lastBucket = Math.floor(now / bucket) * bucket
  const points: LivelinePoint[] = []

  let i = 0
  // Skip trades before the window; they only seed the forward-fill above.
  while (i < trades.length && trades[i].time < firstBucket) i++

  for (let time = firstBucket; time <= lastBucket; time += bucket) {
    let weighted = 0
    let weight = 0
    while (i < trades.length && trades[i].time >= time && trades[i].time < time + bucket) {
      weighted += trades[i].value * trades[i].size
      weight += trades[i].size
      i++
    }
    if (weight > 0) last = weighted / weight
    if (last !== null) points.push({ time, value: last })
  }
  return points
}

/**
 * Fetches the BTC/CUP series from the configured tasak instance and shapes it
 * for the given period.
 * @param period The period for which to fetch historical price data.
 * @param env The environment object carrying TASAK_URL.
 * @returns A promise that resolves to the historical price data for the period.
 */
export const fetchDataForPeriod = async (period: Periods, env: Env): Promise<LivelineData> => {
  if (!env.TASAK_URL) throw new Error('TASAK_URL is not configured')
  const url = `${env.TASAK_URL.replace(/\/$/, '')}/api/history.json`
  const response = await fetch(url, { headers: { 'User-Agent': 'price-chart-proxy' } })
  if (!response.ok) {
    const body = await response.text()
    const { status, statusText } = response
    throw new Error(`tasak request failed with ${status} ${statusText}: ${body}`)
  }
  const trades = parseTrades(await response.json())
  return buildSeries(trades, period, Math.floor(Date.now() / 1000))
}
