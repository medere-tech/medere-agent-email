import { Redis } from '@upstash/redis'

// Même configuration que l'ancien client @vercel/kv (déprécié) : mêmes variables
// KV_REST_API_URL / KV_REST_API_TOKEN, cache fetch 'default', auto-pipelining,
// télémétrie désactivée. Aucun changement de comportement.
process.env.UPSTASH_DISABLE_TELEMETRY = '1'

let client: Redis | null = null

export function kvConfigured(): boolean {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

export function getKv(): Redis {
  if (!client) {
    if (!kvConfigured()) throw new Error('KV non configuré (KV_REST_API_URL / KV_REST_API_TOKEN manquants)')
    client = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
      cache: 'default',
      enableAutoPipelining: true,
    })
  }
  return client
}
