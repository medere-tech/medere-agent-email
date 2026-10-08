import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { checkRateLimit, rateLimitMessage } from '@/lib/ratelimit'
import { checkRelance, originalBody, relanceStatus, storedRelance, type StoredRelance } from '@/lib/relance'
import { generateRelance } from '@/lib/claude'
import { getKv } from '@/lib/kv'
import { KEYS, RELEASE_LOCK_SCRIPT } from '@/lib/kv-schema'
import { RETENTION_DAYS } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Durée maximale d'une rédaction par Claude (le verrou expire seul si le serveur s'arrête en route)
const GEN_LOCK_SECONDS = 180
const WAIT_POLL_MS = 800

const FAILED = 'La rédaction de la relance a échoué. Réessaie.'

// Relance rédigée par Claude (adaptée au statut), une seule fois par mail d'origine :
//   - brouillon déjà rédigé → renvoyé tel quel, sans appel à Claude (rechargement, autre onglet,
//     autre utilisateur autorisé, appel direct) ;
//   - verrou atomique relance_gen_lock:{id} : deux demandes simultanées ne font qu'un appel,
//     la seconde attend le brouillon de la première ;
//   - échec de Claude → verrou libéré, un nouvel essai est possible.
export async function POST(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response
  const { actor } = guard
  let id = ''
  try {
    id = String((await req.json())?.id || '')
    const check = await checkRelance(actor, id)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })

    const already = await storedRelance(id)
    if (already) {
      console.log('[RELANCE] Brouillon déjà rédigé renvoyé, sans appel à Claude :', id)
      return NextResponse.json({ corps: already.corps, dejaRedigee: true })
    }

    const kv = getKv()
    const lockKey = KEYS.relanceGenLock(id)
    const token = randomUUID()
    const locked = await kv.set(lockKey, token, { nx: true, ex: GEN_LOCK_SECONDS })
    if (locked !== 'OK') {
      console.log('[RELANCE] Rédaction déjà en cours, attente du brouillon :', id)
      const draft = await waitForDraft(id, lockKey)
      if (draft) return NextResponse.json({ corps: draft.corps, dejaRedigee: true })
      return NextResponse.json({ error: FAILED }, { status: 503 })
    }

    try {
      const limit = await checkRateLimit('generate', actor.email)
      if (!limit.ok) return NextResponse.json({ error: rateLimitMessage('generate', limit.retryAfterSeconds) }, { status: 429 })

      const { entry, sender } = check
      console.log('[RELANCE] Appel à Claude pour la relance de', id)
      const corps = await generateRelance({
        commercial: { name: sender.name, email: sender.email, phone: sender.phone },
        ps: { titre: entry.ps_titre || '', nom: entry.ps_lastname || '' },
        formationNom: entry.formation_nom || '',
        formationNumero: entry.formation_numero || '',
        statut: relanceStatus(entry),
        sentAt: entry.sent_at || '',
        originalBody: await originalBody(id),
      })
      const stored: StoredRelance = { corps, generated_at: new Date().toISOString(), generated_by: actor.email }
      await kv.set(KEYS.relanceDraft(id), stored, { ex: RETENTION_DAYS * 86400 })
      return NextResponse.json({ corps })
    } finally {
      await kv.eval(RELEASE_LOCK_SCRIPT, [lockKey], [token]).catch(() => {})
    }
  } catch (e: any) {
    console.error('[RELANCE] Rédaction impossible :', id, e.message)
    return NextResponse.json({ error: FAILED }, { status: 500 })
  }
}

// Une autre demande rédige déjà : on attend son brouillon. Verrou disparu sans brouillon = échec.
async function waitForDraft(id: string, lockKey: string): Promise<StoredRelance | null> {
  const kv = getKv()
  const deadline = Date.now() + GEN_LOCK_SECONDS * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS))
    const draft = await storedRelance(id)
    if (draft) return draft
    if (!(await kv.exists(lockKey))) return storedRelance(id)
  }
  return null
}
