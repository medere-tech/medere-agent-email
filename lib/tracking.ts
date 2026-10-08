import { getKv } from '@/lib/kv'
import {
  AUTO_EVENT_WINDOW_SECONDS,
  EMAIL_BODY_TTL_DAYS,
  RELANCE_DELAY_DAYS,
  RETENTION_DAYS,
  TIMEZONE,
} from '@/lib/config'
import {
  KEYS,
  SCHEMA_VERSION,
  STAT_FIELDS,
  EVENT_SCRIPT,
  SEND_SCRIPT,
  addDays,
  commercialKey,
  dayInTimezone,
  dayStartMs,
  statsExpireAt,
} from '@/lib/kv-schema'

export type Statut = 'envoyé' | 'délivré' | 'ouvert' | 'cliqué' | 'bounce' | 'plainte'
export type TrackingEvent = 'delivered' | 'bounced' | 'complained' | 'opened' | 'clicked'

export function parisDay(date: Date | string | number = new Date()): string {
  return dayInTimezone(date, TIMEZONE)
}

// ─── Envoi ────────────────────────────────────────────────────────────────────
export interface RecordSendParams {
  resendId: string
  commercial: { name: string; email: string; hubspot_id?: string; slack_user_id?: string }
  ps: { id: string; titre: string; prenom: string; nom: string; email: string; rpps?: string }
  formation: { nom: string; numero?: string }
  sujet: string
  corps: string
}

export interface RecordSendResult {
  created: boolean
  relanceDate: string
}

// Enregistre l'envoi de façon atomique (email_track NX, index, compteur du jour,
// corps, relance J+3). created = false : l'envoi existait déjà (rejeu idempotent).
export async function recordSend(p: RecordSendParams): Promise<RecordSendResult> {
  const kv = getKv()
  const now = new Date()
  const sentDay = parisDay(now)
  const relanceDate = addDays(sentDay, RELANCE_DELAY_DAYS)
  const ck = commercialKey(p.commercial.email, p.commercial.name)

  const entry = {
    // Champs historiques (lus par /suivi depuis l'origine)
    contact_id: p.ps.id,
    ps_nom: `${p.ps.titre} ${p.ps.prenom} ${p.ps.nom}`.trim(),
    ps_email: p.ps.email,
    commercial_name: p.commercial.name,
    formation_nom: p.formation.nom,
    sujet: p.sujet,
    statut: 'envoyé' as Statut,
    sent_at: now.toISOString(),
    opened_at: null,
    clicked_at: null,
    // Champs v2
    v: 2,
    kind: 'initial',
    sent_day: sentDay,
    commercial_key: ck,
    commercial_email: p.commercial.email.trim().toLowerCase(),
    commercial_slack_id: p.commercial.slack_user_id || '',
    commercial_hubspot_id: p.commercial.hubspot_id || '',
    ps_rpps: p.ps.rpps || '',
    formation_numero: p.formation.numero || '',
    open_count: 0,
    click_count: 0,
    relance_due_day: relanceDate,
    counted_sent: true,
  }

  const created = await kv.eval(
    SEND_SCRIPT,
    [
      KEYS.track(p.resendId),
      KEYS.emailsIndex,
      KEYS.byCommercial(ck),
      KEYS.byContact(p.ps.id || '-'),
      KEYS.statsDay(sentDay),
      KEYS.commerciaux,
      KEYS.body(p.resendId),
      KEYS.relancesDue,
    ],
    [
      JSON.stringify(entry),
      String(now.getTime()),
      p.resendId,
      String(statsExpireAt(sentDay, RETENTION_DAYS)),
      JSON.stringify({ corps: p.corps }),
      String(EMAIL_BODY_TTL_DAYS * 86400),
      String(dayStartMs(relanceDate)),
      p.commercial.name || '',
      '1',
      p.ps.id ? '1' : '0',
    ]
  )
  return { created: Number(created) === 1, relanceDate }
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
export interface ApplyEventResult {
  tracked: boolean
  automatic: boolean
  createOpenNote: boolean
  createClickNote: boolean
  statut: string
  entry: Record<string, any> | null
}

// Applique un événement Resend à l'envoi. eventAt = date de l'événement (created_at du webhook).
export async function applyEvent(
  emailId: string,
  kind: TrackingEvent,
  eventAt: Date,
  messageId = ''
): Promise<ApplyEventResult> {
  const kv = getKv()
  const trackKey = KEYS.track(emailId)
  // sent_at ne change jamais : lu hors du script pour calculer le jour des compteurs
  const entry = await kv.get<Record<string, any>>(trackKey)
  if (!entry) {
    return { tracked: false, automatic: false, createOpenNote: false, createClickNote: false, statut: '', entry: null }
  }

  const sentDay: string = entry.sent_day || parisDay(entry.sent_at || eventAt)
  const reference = Date.parse(entry.delivered_at || entry.sent_at || '')
  const automatic =
    (kind === 'opened' || kind === 'clicked') &&
    Number.isFinite(reference) &&
    eventAt.getTime() - reference < AUTO_EVENT_WINDOW_SECONDS * 1000

  const res = (await kv.eval(
    EVENT_SCRIPT,
    [KEYS.track(emailId), KEYS.statsDay(sentDay), KEYS.noteLock(emailId, 'opened'), KEYS.noteLock(emailId, 'clicked')],
    [kind, eventAt.toISOString(), automatic ? '1' : '0', String(statsExpireAt(sentDay, RETENTION_DAYS)), messageId]
  )) as [number, number, number, string]

  return {
    tracked: Number(res[0]) === 1,
    automatic,
    createOpenNote: Number(res[1]) === 1,
    createClickNote: Number(res[2]) === 1,
    statut: res[3] || '',
    entry,
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
export type Stats = Record<(typeof STAT_FIELDS)[number], number>

export function emptyStats(): Stats {
  return { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 }
}

export async function isMigrated(): Promise<boolean> {
  return (await getKv().get<string | number>(KEYS.schemaVersion))?.toString() === SCHEMA_VERSION
}

// Somme des compteurs journaliers entre deux jours inclus (AAAA-MM-JJ, heure de Paris),
// tous commerciaux ou un seul (clé commercial).
export async function statsFromCounters(fromDay: string, toDay: string, commercial?: string): Promise<Stats> {
  const days: string[] = []
  for (let d = fromDay; d <= toDay && days.length <= RETENTION_DAYS + 1; d = addDays(d, 1)) days.push(d)
  const stats = emptyStats()
  if (!days.length) return stats

  const kv = getKv()
  const pipe = kv.pipeline()
  for (const d of days) pipe.hgetall(KEYS.statsDay(d))
  const hashes = (await pipe.exec()) as (Record<string, unknown> | null)[]

  for (const h of hashes) {
    if (!h) continue
    for (const f of STAT_FIELDS) {
      stats[f] += Number(h[commercial ? `${f}|${commercial}` : f] || 0)
    }
  }
  return stats
}

// Stats calculées à partir des entrées elles-mêmes (base non migrée, ou filtres
// que les compteurs ne couvrent pas). Mêmes règles que les compteurs.
export function statsFromEntries(entries: Record<string, any>[]): Stats {
  const stats = emptyStats()
  for (const e of entries) {
    const opened = !!(e.first_opened_at || e.opened_at || e.first_clicked_at || e.clicked_at || e.statut === 'ouvert' || e.statut === 'cliqué')
    const clicked = !!(e.first_clicked_at || e.clicked_at || e.statut === 'cliqué')
    const complained = !!(e.complained_at || e.statut === 'plainte')
    stats.sent++
    if (e.delivered_at || opened || complained || e.statut === 'délivré' || e.first_auto_opened_at || e.first_auto_clicked_at) stats.delivered++
    if (opened) stats.opened++
    if (clicked) stats.clicked++
    if (e.bounced_at || e.statut === 'bounce') stats.bounced++
    if (complained) stats.complained++
  }
  return stats
}

// ─── Purge RGPD ───────────────────────────────────────────────────────────────
// Supprime les envois plus anciens que RETENTION_DAYS (email_track, corps, verrous,
// index, relance rattachée). Les compteurs journaliers expirent seuls (EXPIREAT).
export async function purgeExpired(maxBatches = 20, batchSize = 200): Promise<number> {
  const kv = getKv()
  const cutoff = Date.now() - RETENTION_DAYS * 86400000
  let purged = 0

  for (let batch = 0; batch < maxBatches; batch++) {
    const ids = (await kv.zrange(KEYS.emailsIndex, 0, cutoff, { byScore: true, offset: 0, count: batchSize })) as string[]
    if (!ids.length) break

    const entries = await kv.mget<(Record<string, any> | null)[]>(...ids.map((id) => KEYS.track(id)))
    const all = ids.map((id, i) => ({ id, entry: entries[i] }))
    // Une relance (lot 3) est rattachée à son mail d'origine et part avec lui
    const relanceIds = entries.map((e) => e?.relance_id).filter((x): x is string => !!x)
    if (relanceIds.length) {
      const relances = await kv.mget<(Record<string, any> | null)[]>(...relanceIds.map((id) => KEYS.track(id)))
      relanceIds.forEach((id, i) => all.push({ id, entry: relances[i] }))
    }

    const pipe = kv.pipeline()
    for (const { id, entry } of all) {
      pipe.del(KEYS.track(id), KEYS.body(id), KEYS.sendResult(id), KEYS.noteLock(id, 'opened'), KEYS.noteLock(id, 'clicked'))
      pipe.zrem(KEYS.relancesDue, id)
      if (entry?.commercial_key) pipe.zrem(KEYS.byCommercial(entry.commercial_key), id)
      if (entry?.contact_id) pipe.zrem(KEYS.byContact(entry.contact_id), id)
    }
    pipe.zrem(KEYS.emailsIndex, ...ids)
    await pipe.exec()

    purged += ids.length
    if (ids.length < batchSize) break
  }
  return purged
}
