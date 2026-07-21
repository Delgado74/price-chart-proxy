import { isValidResetToken } from './utils'
import { Env, Fiats, KVData, Periods } from './types'
import { getDataForPeriod, isStale, refreshDataForPeriod, resetKVStorage, updateDataForPeriod } from './kv'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const respondWith = (data: any | null, code: number, cacheable = false) => {
  const responseData = data ? JSON.stringify(data) : null
  return new Response(responseData, {
    status: code,
    headers: {
      ...corsHeaders,
      'content-type': 'application/json',
      'cache-control': cacheable ? 'public, max-age=300' : 'no-store',
    },
  })
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return respondWith(null, 204)
    }

    // Extract params from request
    const fiat = extractFiatFromRequest(request) // default to USD
    const period = extractPeriodFromRequest(request) // default to oneDay
    const resetToken = await extractResetTokenFromRequest(request) // optional

    // Reject invalid params early so they never reach (and burn quota on) upstream providers
    if (!fiat) return respondWith({ error: `Unsupported fiat, must be one of: ${Object.values(Fiats).join(', ')}` }, 400)
    if (!period)
      return respondWith({ error: `Unsupported period, must be one of: ${Object.values(Periods).join(', ')}` }, 400)

    // Check for reset token and reset KV storage if valid
    try {
      if (resetToken && (await isValidResetToken(resetToken))) {
        await resetKVStorage(env)
        return respondWith({ status: 'KV storage reset successfully' }, 200)
      }
    } catch (error) {
      return respondWith({ error: `Unable to reset KV storage: ${extractErrorMessage(error)}` }, 500)
    }

    let cached: KVData | null = null
    try {
      cached = await getDataForPeriod(env, period, fiat)
    } catch {}

    // Stale-while-revalidate: always serve cached data immediately and refresh
    // in the background when stale, so upstream errors (e.g. rate limits) never
    // surface to users once a key has been populated.
    if (cached) {
      if (isStale(cached, period)) {
        ctx.waitUntil(refreshDataForPeriod(env, period, fiat))
      }
      return respondWith(cached, 200, true)
    }

    // Cold cache: fetch synchronously as we have nothing to serve
    try {
      const data = await updateDataForPeriod(env, period, fiat)
      return respondWith(data, 200, true)
    } catch (error) {
      // The initial cache read may have failed transiently; retry it before giving up
      try {
        const data = await getDataForPeriod(env, period, fiat)
        if (data) return respondWith(data, 200, true)
      } catch {}
      return respondWith({ error: `Failed to update data: ${extractErrorMessage(error)}` }, 500)
    }
  },
} satisfies ExportedHandler<Env>

const extractPeriodFromRequest = (request: Request): Periods | null => {
  const url = new URL(request.url)
  const period = url.searchParams.get('period')
  if (!period) return Periods.oneDay
  return Object.values(Periods).includes(period as Periods) ? (period as Periods) : null
}

const extractFiatFromRequest = (request: Request): Fiats | null => {
  const url = new URL(request.url)
  const fiat = url.searchParams.get('fiat')
  if (!fiat) return Fiats.USD
  const upper = fiat.toUpperCase()
  return Object.values(Fiats).includes(upper as Fiats) ? (upper as Fiats) : null
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
