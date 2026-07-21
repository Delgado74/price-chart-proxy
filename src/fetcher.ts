import * as coinbase from './coinbase'
import * as coingecko from './coingecko'
import { Env, Fiats, KVData, Periods } from './types'

/**
 * This file contains the main logic for fetching historical price data for Bitcoin in various fiat currencies and time
 * periods. It tries to fetch the data from the Coinbase API first, and if that fails (e.g. due to unsupported trading
 * pair or API issues), it falls back to the Coingecko API. The fetched data is then structured in a consistent format
 * and can be stored in the KV storage for caching purposes.
 */

/**
 * Fetches historical price data for the given period from the Coinbase API, and falls back
 * to the Coingecko API if the Coinbase API fails or returns no data.
 * @param period The period for which to fetch historical price data.
 * @param fiat The fiat currency for which to fetch historical price data.
 * @param env The environment object carrying provider configuration (e.g. Coingecko API key).
 * @returns A promise that resolves to the historical price data for the given period.
 */
export const fetchDataForPeriod = async (period: Periods, fiat: Fiats, env: Env): Promise<KVData> => {
  try {
    if (!coinbase.isSupportedFiat(fiat)) throw new Error(`Unsupported trading pair: BTC-${fiat}`)
    const data = await coinbase.fetchDataForPeriod(period, fiat)
    if (!data || data.length === 0) throw new Error('No data returned from Coinbase API')
    return { data, from: 'coinbase', when: Date.now() }
  } catch {
    const data = await coingecko.fetchDataForPeriod(period, fiat, env.COINGECKO_API_KEY)
    if (!data || data.length === 0) throw new Error('No data returned from Coingecko API')
    return { data, from: 'coingecko', when: Date.now() }
  }
}
