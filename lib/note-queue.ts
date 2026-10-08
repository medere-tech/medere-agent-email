import { getKv } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { HUBSPOT_RETRY_DELAY_HOURS, HUBSPOT_RETRY_MAX_ATTEMPTS } from '@/lib/config'
import { createNote } from '@/lib/hubspot'
import { sendAlert } from '@/lib/slack'

// Notes HubSpot en échec : file hubspot_retry (sorted set, score = prochain essai en ms, membre =
// identifiant) + hubspot_retry:{id} (contenu de la Note, expire après 7 jours). Le cron retente
// toutes les HUBSPOT_RETRY_DELAY_HOURS ; après HUBSPOT_RETRY_MAX_ATTEMPTS essais au total, la Note
// est abandonnée et une alerte part en DM.
export interface PendingNote {
  id: string
  contactId: string
  body: string
  ownerId?: string
  label: string // ex. « Email envoyé — [sujet] » (pour l'alerte)
  attempts: number // essais déjà faits (le premier, immédiat, compte)
  firstError: string
  firstFailedAt: string
}

const NOTE_TTL = 7 * 86400
const noteKey = (id: string) => `${KEYS.hubspotRetry}:${id}`

export async function enqueueNote(note: Omit<PendingNote, 'id' | 'attempts' | 'firstFailedAt'>): Promise<void> {
  const pending: PendingNote = { ...note, id: crypto.randomUUID(), attempts: 1, firstFailedAt: new Date().toISOString() }
  try {
    const kv = getKv()
    await kv.set(noteKey(pending.id), pending, { ex: NOTE_TTL })
    await kv.zadd(KEYS.hubspotRetry, { score: Date.now() + HUBSPOT_RETRY_DELAY_HOURS * 3600000, member: pending.id })
    console.warn('[HUBSPOT] Note en échec mise en file pour un nouvel essai :', note.label)
  } catch (e: any) {
    console.error('[HUBSPOT] Note perdue (file indisponible) :', note.label, e.message)
    await sendAlert('Note HubSpot non créée', [note.label, `Contact HubSpot ${note.contactId}`, `Erreur : ${note.firstError}`, `File de nouvel essai indisponible : ${e.message}`])
  }
}

export interface RetryReport {
  created: number
  requeued: number
  abandoned: number
  errors: string[]
}

// Appelé par le cron : retente les Notes dues. Chaque identifiant est « réclamé » par ZREM :
// deux passages simultanés du cron ne créent pas deux fois la même Note.
export async function processNoteRetries(now = Date.now()): Promise<RetryReport> {
  const kv = getKv()
  const report: RetryReport = { created: 0, requeued: 0, abandoned: 0, errors: [] }
  const due = (await kv.zrange(KEYS.hubspotRetry, 0, now, { byScore: true })) as string[]
  for (const id of due) {
    if (Number(await kv.zrem(KEYS.hubspotRetry, id)) !== 1) continue
    const note = await kv.get<PendingNote>(noteKey(id))
    if (!note) continue
    try {
      await createNote(note.contactId, note.body, note.ownerId)
      await kv.del(noteKey(id))
      report.created++
    } catch (e: any) {
      const attempts = note.attempts + 1
      if (attempts >= HUBSPOT_RETRY_MAX_ATTEMPTS) {
        await kv.del(noteKey(id))
        report.abandoned++
        report.errors.push(`Note HubSpot abandonnée après ${attempts} essais : ${note.label}`)
        await sendAlert('Note HubSpot non créée (échec définitif)', [
          note.label,
          `Contact HubSpot ${note.contactId}`,
          `${attempts} essais depuis le ${note.firstFailedAt.slice(0, 16).replace('T', ' ')} (UTC)`,
          `Première erreur : ${note.firstError.slice(0, 300)}`,
          `Dernière erreur : ${String(e.message).slice(0, 300)}`,
        ])
      } else {
        report.requeued++
        await kv.set(noteKey(id), { ...note, attempts }, { ex: NOTE_TTL })
        await kv.zadd(KEYS.hubspotRetry, { score: now + HUBSPOT_RETRY_DELAY_HOURS * 3600000, member: id })
      }
    }
  }
  return report
}
