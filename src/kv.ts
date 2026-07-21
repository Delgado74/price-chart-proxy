import { fetchDataForPeriod } from './fetcher'
import { Env, Fiats, KVData, Periods } from './types'

/**
 * This file contains functions to interact with the KV storage for caching the fetched data.
 */

export const resetKVStorage = async (env: Env): Promise<void> => {
  const keys = await env.price_chart_proxy_kv.list()
  await Promise.all(keys.keys.map((key) => env.price_chart_proxy_kv.delete(key.name)))
}

/**
 * Checks if the cached data is stale for the given period based on its write timestamp.
 * @param data The cached data to check.
 * @param period The period the data belongs to.
 * @returns boolean
 */
export const isStale = (data: KVData, period: Periods): boolean => {
  return Date.now() - data.when > getMaxAgeAllowed(period)
}

/**
 * Updates the cached data for the given period by fetching new data
 * from the Coinbase or Coingecko API and storing it in the KV storage.
 * @param env The environment object containing the KV storage.
 * @param period The period for which to update the cached data.
 * @param fiat The fiat currency for which to update the cached data.
 * @returns The updated data for the given period.
 */
export const updateDataForPeriod = async (env: Env, period: Periods, fiat: Fiats): Promise<KVData> => {
  const kvData = await fetchDataForPeriod(period, fiat, env.COINGECKO_API_KEY)
  await saveData(env, getKey(period, fiat), kvData)
  return kvData
}

/**
 * Background refresh used by the stale-while-revalidate flow. A best-effort KV
 * lock ensures roughly one refresh per key per minute, so a burst of requests
 * on a stale key doesn't stampede the upstream APIs. Errors are swallowed:
 * the stale data keeps being served until a refresh eventually succeeds.
 * @param env The environment object containing the KV storage.
 * @param period The period for which to refresh the cached data.
 * @param fiat The fiat currency for which to refresh the cached data.
 */
export const refreshDataForPeriod = async (env: Env, period: Periods, fiat: Fiats): Promise<void> => {
  try {
    const lockKey = `lock-${getKey(period, fiat)}`
    const locked = await env.price_chart_proxy_kv.get(lockKey)
    if (locked) return
    await env.price_chart_proxy_kv.put(lockKey, '1', { expirationTtl: 60 })
    await updateDataForPeriod(env, period, fiat)
  } catch {}
}

/**
 * Retrieves the cached data for the given period from the KV storage.
 * @param env The environment object containing the KV storage.
 * @param period The period for which to retrieve the cached data.
 * @param fiat The fiat currency for which to retrieve the cached data.
 * @returns The cached data for the given period, or null if not found.
 */
export const getDataForPeriod = async (env: Env, period: Periods, fiat: Fiats): Promise<KVData | null> => {
  const data = await loadData(env, getKey(period, fiat))
  return data ? data : null
}

/**
 * Returns the maximum allowed age for updating the cached data based on the period.
 * The minimum granularity in the chart UX is one hour, so nothing is refreshed
 * more often than hourly.
 * @param period The period for which to get the maximum age.
 * @returns The maximum age in milliseconds.
 */
const getMaxAgeAllowed = (period: Periods): number => {
  if (period === Periods.oneHour) return 60 * 60 * 1000 // 1 hour
  if (period === Periods.oneDay) return 60 * 60 * 1000 // 1 hour
  return 24 * 60 * 60 * 1000 // 24 hours for all other periods
}

/**
 * Generates a key for storing data in the KV storage based on the period and fiat currency.
 * @param period The period for which to generate the key.
 * @param fiat The fiat currency for which to generate the key.
 * @returns The generated key.
 */
const getKey = (period: Periods, fiat: Fiats) => `${period}-${fiat}`

/**
 * Loads data from the KV storage for the given key.
 * @param env The environment object containing the KV storage.
 * @param key The key for which to load the data.
 * @returns The loaded data, or null if not found.
 */
const loadData = async (env: Env, key: string): Promise<KVData | null> => {
  const data = await env.price_chart_proxy_kv.get(key)
  return data ? (JSON.parse(data) as KVData) : null
}

/**
 * Saves data to the KV storage for the given key.
 * Data keys never expire: stale data is always available as a fallback.
 * @param env The environment object containing the KV storage.
 * @param key The key for which to save the data.
 * @param data The data to be saved.
 */
const saveData = async (env: Env, key: string, data: KVData): Promise<void> => {
  await env.price_chart_proxy_kv.put(key, JSON.stringify(data))
}
