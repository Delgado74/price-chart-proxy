import { isValidResetToken } from './utils'
import { Env, Fiats, KVData, Periods } from './types'
import { getDataForPeriod, periodNeedsUpdate, resetKVStorage, updateDataForPeriod } from './kv'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const respondWith = (data: any | null, code: number) => {
  const responseData = data ? JSON.stringify(data) : null
  return new Response(responseData, {
    status: code,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json',
    },
  })
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return respondWith(null, 204)
    }

    let data: KVData | null = null

    // Extract params from request
    const fiat = extractFiatFromRequest(request) // default to USD
    const period = extractPeriodFromRequest(request) // default to oneDay
    const resetToken = await extractResetTokenFromRequest(request) // optional

    // Check for reset token and reset KV storage if valid
    try {
      if (resetToken && (await isValidResetToken(resetToken))) {
        await resetKVStorage(env)
        return respondWith({ status: 'KV storage reset successfully' }, 200)
      }
    } catch (error) {
      return respondWith({ error: `Unable to reset KV storage: ${extractErrorMessage(error)}` }, 500)
    }

    // Determine whether cached data is stale; if we can't tell, assume an update is needed.
    let needsUpdate = true
    try {
      needsUpdate = await periodNeedsUpdate(env, period, fiat)
    } catch {
      needsUpdate = true
    }

    if (needsUpdate) {
      try {
        data = await updateDataForPeriod(env, period, fiat)
      } catch (error) {
        // Fallback to cached data if updating fails
        try {
          data = await getDataForPeriod(env, period, fiat)
        } catch {}

        if (!data) {
          return respondWith({ error: `Failed to update data: ${extractErrorMessage(error)}` }, 500)
        }
      }
    } else {
      try {
        data = await getDataForPeriod(env, period, fiat)
      } catch (error) {
        // If cache read fails, try to refresh as a last resort.
        try {
          data = await updateDataForPeriod(env, period, fiat)
        } catch {
          return respondWith({ error: `Failed to get data: ${extractErrorMessage(error)}` }, 500)
        }
      }
    }

    const result = data ?? { error: 'No data available' }
    return respondWith(result, 200)
  },
} satisfies ExportedHandler<Env>

const extractPeriodFromRequest = (request: Request): Periods => {
  const url = new URL(request.url)
  const period = url.searchParams.get('period')
  return (period as Periods) ?? Periods.oneDay
}

const extractFiatFromRequest = (request: Request): Fiats => {
  const url = new URL(request.url)
  const fiat = url.searchParams.get('fiat')
  return (fiat?.toUpperCase() as Fiats) ?? Fiats.USD
}

const extractResetTokenFromRequest = async (request: Request): Promise<string | null> => {
  const url = new URL(request.url)
  return url.searchParams.get('reset')
}

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown error'
}
