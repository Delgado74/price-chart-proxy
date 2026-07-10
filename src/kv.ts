import { fetchDataForPeriod } from './fetcher'
import { Env, Fiats, KVData, LivelineData, Periods } from './types'

/**
 * This file contains functions to interact with the KV storage for caching the fetched data.
 */

export const resetKVStorage = async (env: Env): Promise<void> => {
  const keys = await env.price_chart_proxy_kv.list()
  await Promise.all(keys.keys.map((key) => env.price_chart_proxy_kv.delete(key.name)))
}

/**
 * Checks if the cached data for the given period needs to be updated based on the last update timestamp.
 * @param env The environment object containing the KV storage.
 * @param period The period for which to check if the cached data needs to be updated.
 * @param fiat The fiat currency for which to check if the cached data needs to be updated.
 * @returns boolean
 */
export const periodNeedsUpdate = async (env: Env, period: Periods, fiat: Fiats): Promise<boolean> => {
  const data = await loadData(env, getKey(period, fiat))
  if (!data) return true
  return Date.now() - data.when > getMaxAgeAllowed(period)
}

/**
 * Updates the cached data for the given period by fetching new data
 * from the Coinbase or Coingecko API and storing it in the KV storage.
 * @param env The environment object containing the KV storage.
 * @param period The period for which to check if the cached data needs to be updated.
 * @param fiat The fiat currency for which to check if the cached data needs to be updated.
 * @returns The updated data for the given period.
 */
export const updateDataForPeriod = async (env: Env, period: Periods, fiat: Fiats): Promise<KVData> => {
  const kvData = await fetchDataForPeriod(period, fiat)
  await saveData(env, getKey(period, fiat), kvData)
  return kvData
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
 * @param period The period for which to get the maximum age.
 * @returns The maximum age in milliseconds.
 */
const getMaxAgeAllowed = (period: Periods): number => {
  if (period === Periods.oneHour) return 10 * 60 * 1000 // 10 minutes
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
 * @param env The environment object containing the KV storage.
 * @param key The key for which to save the data.
 * @param data The data to be saved.
 */
const saveData = async (env: Env, key: string, data: KVData): Promise<void> => {
  await env.price_chart_proxy_kv.put(key, JSON.stringify(data))
}
