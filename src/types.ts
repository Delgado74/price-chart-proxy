export interface Env {
  price_chart_proxy_kv: KVNamespace
  COINGECKO_API_KEY?: string
}

export enum Fiats {
  EUR = 'EUR',
  USD = 'USD',
  CHF = 'CHF',
  JPY = 'JPY',
  GBP = 'GBP',
  CNY = 'CNY',
  BRL = 'BRL',
}

export type LivelinePoint = {
  time: number
  value: number
}

export type LivelineData = LivelinePoint[]

export interface KVData {
  data: LivelineData
  when: number
  from: string
}

export enum Periods {
  oneHour = 'oneHour',
  oneDay = 'oneDay',
  oneWeek = 'oneWeek',
  oneMonth = 'oneMonth',
  oneYear = 'oneYear',
  all = 'all',
}
