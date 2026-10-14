import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { checkRateLimit, rateLimitMessage } from '@/lib/ratelimit'
import { STORED_RELANCE_VERSION, checkRelance, draftAJour, relanceSessions, storedRelance, type RelanceSessions, type StoredRelance } from '@/lib/relance'
import { generateRelance } from '@/lib/claude'
import { checkDates } from '@/lib/session-label'
import { getKv } from '@/lib/kv'
import { KEYS, RELEASE_LOCK_SCRIPT } from '@/lib/kv-schema'
import { RETENTION_DAYS } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Durée maximale d'une rédaction par Claude (le verrou expire seul si le serveur s'arrête en route)
const GEN_LOCK_SECONDS = 180
const WAIT_POLL_MS = 800

const FAILED = 'La rédaction de la relance a échoué. Réessaie.'

// Relance rédigée par Claude, une seule fois par mail d'origine, identique quel que soit le statut
// (le statut n'est jamais transmis au prompt) :
//   - sessions relues dans Airtable (relanceSessions) ; aucune session ouverte → refus, sans appel ;
//   - brouillon déjà rédigé avec les sessions du jour → renvoyé tel quel, sans appel à Claude
//     (rechargement, autre onglet, autre utilisateur autorisé, appel direct) ; brouillon dont les
//     sessions ne sont plus celles du jour → ignoré et rédigé de nouveau (un seul appel) ;
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

    const rs = await relanceSessions(id, check.entry)
    if (rs.mode === 'aucune') return NextResponse.json({ error: rs.message }, { status: 409 })

    const stored = await storedRelance(id)
    const already = stored && draftAJour(stored, rs) ? stored : null
    if (stored && !already) console.log('[RELANCE] Brouillon enregistré obsolète (sessions changées), nouvelle rédaction :', id)
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
      const draft = await waitForDraft(id, lockKey, rs)
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
        format: rs.format,
        sessions: rs.sessions,
      })
      const datesKo = checkDates(corps, rs.today)
      if (datesKo.length) console.warn('[RELANCE] Dates incohérentes ou passées dans la relance rédigée :', id, datesKo.map((w) => w.extrait).join(' | '))
      const draft: StoredRelance = {
        v: STORED_RELANCE_VERSION, corps, generated_at: new Date().toISOString(), generated_by: actor.email,
        sessions: rs.sessions.map((s) => String(s.numero)),
      }
      await kv.set(KEYS.relanceDraft(id), draft, { ex: RETENTION_DAYS * 86400 })
      return NextResponse.json({ corps })
    } finally {
      await kv.eval(RELEASE_LOCK_SCRIPT, [lockKey], [token]).catch(() => {})
    }
  } catch (e: any) {
    console.error('[RELANCE] Rédaction impossible :', id, e.message)
    return NextResponse.json({ error: FAILED }, { status: 500 })
  }
}

// Une autre demande rédige déjà : on attend son brouillon (aux sessions du jour). Verrou disparu
// sans brouillon = échec.
async function waitForDraft(id: string, lockKey: string, rs: RelanceSessions): Promise<StoredRelance | null> {
  const kv = getKv()
  const deadline = Date.now() + GEN_LOCK_SECONDS * 1000
  const fresh = async () => { const d = await storedRelance(id); return d && draftAJour(d, rs) ? d : null }
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS))
    const draft = await fresh()
    if (draft) return draft
    if (!(await kv.exists(lockKey))) return fresh()
  }
  return null
}
