import { getKv, kvConfigured } from '@/lib/kv'
import { RATE_LIMITS } from '@/lib/config'

export type RateAction = keyof typeof RATE_LIMITS

export interface RateResult {
  ok: boolean
  retryAfterSeconds: number
}

// Limite de débit par personne connectée, fenêtre fixe dans le KV :
// ratelimit:{action}:{email}:{n° de fenêtre}, expirée avec la fenêtre.
// KV indisponible : la requête passe (journalisé) plutôt que de bloquer les commerciaux.
export async function checkRateLimit(action: RateAction, email: string): Promise<RateResult> {
  const { max, windowSeconds } = RATE_LIMITS[action]
  if (!kvConfigured()) return { ok: true, retryAfterSeconds: 0 }
  const now = Math.floor(Date.now() / 1000)
  const window = Math.floor(now / windowSeconds)
  const key = `ratelimit:${action}:${email}:${window}`
  try {
    const kv = getKv()
    const count = await kv.incr(key)
    if (count === 1) await kv.expire(key, windowSeconds)
    if (count > max) return { ok: false, retryAfterSeconds: (window + 1) * windowSeconds - now }
    return { ok: true, retryAfterSeconds: 0 }
  } catch (e: any) {
    console.error('[RATELIMIT] KV indisponible, requête acceptée :', e.message)
    return { ok: true, retryAfterSeconds: 0 }
  }
}

export function rateLimitMessage(action: RateAction, retryAfterSeconds: number): string {
  const { max, windowSeconds } = RATE_LIMITS[action]
  const what = action === 'generate' ? 'générations' : 'envois'
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60))
  return `Tu as atteint la limite de ${max} ${what} en ${windowSeconds / 60} minutes. Réessaie dans ${minutes} minute${minutes > 1 ? 's' : ''}.`
}
