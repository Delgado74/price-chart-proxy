import { Fiats, LivelineData, Periods } from './types'
import { ms2secs } from './utils'

/**
 * This file contains functions to interact with the Coingecko API to fetch the historical price data
 * for Bitcoin in USD for different periods, and to store it in the KV storage for caching purposes.
 */

// This type represents the structure of the data returned by the Coingecko API for each candle
type CoingeckoPoint = [
  number, // time
  number, // value
]

// This type represents the structure of the response returned by the Coingecko API for market chart data
type CoingeckoResponse = {
  prices: CoingeckoPoint[]
}

// Granularity values in seconds for different time intervals
enum Granularities {
  fiveMinutes = '5m', // only availabe for enterprise plan
  hourly = 'hourly', // only available for 1 day period
  daily = 'daily', // available for 7, 30 and 365 periods
  max = 'max', // fake granularity to fetch all available data with the free tier
}

/**
 * Coingecko supports all wallet currencies, so we return true for any fiat.
 * The Coinbase API will be the one throwing an error if the fiat is not supported.
 * @param fiat The fiat currency to check.
 * @returns True if the fiat currency is supported, false otherwise.
 */
export const isSupportedFiat = (fiat: string): fiat is Fiats => {
  return true
}

/**
 *  Fetches historical price data from the Coingecko API for the given period and returns it in a structured format.
 * @param period The period for which to fetch data.
 * @returns A promise that resolves to the historical price data for the given period.
 */
export const fetchDataForPeriod = async (period: Periods, fiat: Fiats, apiKey?: string): Promise<LivelineData> => {
  switch (period) {
    case Periods.oneHour:
      return await fetchLastHourData(fiat, apiKey)
    case Periods.oneDay:
      return await fetchLastDayData(fiat, apiKey)
    case Periods.oneWeek:
      return await fetchLastWeekData(fiat, apiKey)
    case Periods.oneMonth:
      return await fetchLastMonthData(fiat, apiKey)
    case Periods.oneYear:
      return await fetchLastYearData(fiat, apiKey)
    case Periods.all:
      return await fetchAllData(fiat, apiKey)
    default:
      throw new Error(`Unsupported period: ${period}`)
  }
}

/**
 * Fetches the historical price data for the last hour from the Coingecko API with minute granularity.
 * @param fiat The fiat currency for which to fetch historical price data.
 * @returns A promise that resolves to the historical price data for the last hour.
 */
const fetchLastHourData = async (fiat: Fiats, apiKey?: string): Promise<LivelineData> => {
  const days = 1
  const oneHour = 60 * 60 * 1000
  const granularity = Granularities.max
  const startTime = new Date(Date.now() - oneHour)
  const data = await getData(days, granularity, fiat, apiKey)
  return data.filter((point) => point.time * 1000 > startTime.getTime())
}

/**
 * Fetches the historical price data for the last day from the Coingecko API with hour granularity.
 * @param fiat The fiat currency for which to fetch historical price data.
 * @returns A promise that resolves to the historical price data for the last day.
 */
const fetchLastDayData = async (fiat: Fiats, apiKey?: string): Promise<LivelineData> => {
  const days = 1
  const oneDay = 24 * 60 * 60 * 1000
  const granularity = Granularities.hourly
  const startTime = new Date(Date.now() - oneDay)
  const data = await getData(days, granularity, fiat, apiKey)
  return data.filter((point) => point.time * 1000 > startTime.getTime())
}

/**
 * Fetches the historical price data for the last week from the Coingecko API with hour granularity.
 * @param fiat The fiat currency for which to fetch historical price data.
 * @returns A promise that resolves to the historical price data for the last week.
 */
const fetchLastWeekData = async (fiat: Fiats, apiKey?: string): Promise<LivelineData> => {
  const days = 7
  const oneWeek = 7 * 24 * 60 * 60 * 1000
  const granularity = Granularities.hourly
  const startTime = new Date(Date.now() - oneWeek)
  const data = await getData(days, granularity, fiat, apiKey)
  return data.filter((point) => point.time * 1000 > startTime.getTime())
}

/**
 * Fetches the historical price data for the last month from the Coingecko API with daily granularity.
 * @param fiat The fiat currency for which to fetch historical price data.
 * @returns A promise that resolves to the historical price data for the last month.
 */
const fetchLastMonthData = async (fiat: Fiats, apiKey?: string): Promise<LivelineData> => {
  const days = 30
  const granularity = Granularities.daily
  const oneMonth = 30 * 24 * 60 * 60 * 1000
  const startTime = new Date(Date.now() - oneMonth)
  const data = await getData(days, granularity, fiat, apiKey)
  return data.filter((point) => point.time * 1000 > startTime.getTime())
}

/**
 * Fetches the historical price data for the last year from the Coingecko API with daily granularity
 * @param fiat The fiat currency for which to fetch historical price data.
 * @returns A promise that resolves to the historical price data for the last year.
 */
const fetchLastYearData = async (fiat: Fiats, apiKey?: string): Promise<LivelineData> => {
  const days = 365
  const granularity = Granularities.daily
  const oneYear = 365 * 24 * 60 * 60 * 1000
  const startTime = new Date(Date.now() - oneYear)
  const data = await getData(days, granularity, fiat, apiKey)
  return data.filter((point) => point.time * 1000 > startTime.getTime())
}

/**
 * Fetches all historical price data from the Coingecko API starting from the first day until now
 * @param fiat The fiat currency for which to fetch historical price data.
 * @returns A promise that resolves to the historical price data for all periods.
 */
const fetchAllData = async (fiat: Fiats, apiKey?: string): Promise<LivelineData> => {
  return fetchLastYearData(fiat, apiKey) // Coingecko free tier only allows a max of 365 days of data
}

/**
 * Fetches historical price data from the Coingecko API for the given date range and granularity.
 * @param days The number of days for which to fetch data.
 * @param granularity The granularity of the data in seconds.
 * @param fiat The fiat currency for which to fetch historical price data.
 * @param apiKey Optional Coingecko demo API key, sent as x-cg-demo-api-key for dedicated rate limits.
 * @returns A promise that resolves to the historical price data for the given date range.
 */
const getData = async (days: number, granularity: Granularities, fiat: Fiats, apiKey?: string): Promise<LivelineData> => {
  const url = getUrl(days, granularity, fiat)
  const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey
  const coingeckoResponse = await fetch(url, { headers })
  if (!coingeckoResponse.ok) {
    const body = await coingeckoResponse.text()
    const { status, statusText } = coingeckoResponse
    throw new Error(`CoinGecko request failed with ${status} ${statusText}: ${body}`)
  }
  const data: CoingeckoResponse = await coingeckoResponse.json()
  return data.prices.map((item: CoingeckoPoint) => ({ time: ms2secs(item[0]), value: item[1] }))
}

/**
 * Generates the URL for fetching historical price data from the Coingecko API.
 * @param days The number of days for which to fetch data.
 * @param granularity The granularity of the data in seconds.
 * @param fiat The fiat currency for which to fetch historical price data.
 * @returns The URL for the Coingecko API request.
 */
const getUrl = (days: number, granularity: Granularities, fiat: Fiats) => {
  const host = 'https://api.coingecko.com'
  const path = '/api/v3/coins/bitcoin/market_chart'
  const params = new URLSearchParams({
    days: days.toString(),
    vs_currency: fiat.toLowerCase(),
    ...(granularity !== Granularities.max && { interval: granularity }),
  })
  return `${host}${path}?${params.toString()}`
}
