import { getKv } from '@/lib/kv'
import { KEYS, STAT_FIELDS, SUIVI_QUERY_SCRIPT, addDays, commercialKey, dayInTimezone } from '@/lib/kv-schema'
import { TIMEZONE } from '@/lib/config'
import type { Actor } from '@/lib/identity'
import type { Fiche } from '@/lib/roles'
import { statsFromEntries } from '@/lib/tracking'

// Requête de /suivi et de son export CSV : période (jours, heure de Paris), « Mes envois »,
// commercial, statut, formation, recherche par nom ou email du PS.

export const SUIVI_PAGE_SIZE = 20
export const DEFAULT_PERIOD_DAYS = 30
export const MAX_PERIOD_DAYS = 1100 // au-delà, la purge RGPD a déjà tout supprimé
export const STATUTS = ['envoyé', 'délivré', 'ouvert', 'cliqué', 'bounce', 'plainte'] as const

export type SuiviStats = Record<(typeof STAT_FIELDS)[number], number>

export interface SuiviFilters {
  from: string
  to: string
  fromMs: number
  toMs: number
  mine: boolean
  commercial: string // clé commercial effective ('' = toute l'équipe)
  statut: string
  formation: string
  q: string // tel que saisi
  page: number
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function parisToday(): string {
  return dayInTimezone(new Date(), TIMEZONE)
}

// Minuit (heure de Paris) du jour donné, en ms UTC : 22 h ou 23 h UTC la veille selon l'heure d'été
export function parisDayStartMs(day: string): number {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`)
  for (const h of [1, 2, 0, 3]) {
    const t = utcMidnight - h * 3600000
    if (dayInTimezone(t, TIMEZONE) === day && dayInTimezone(t - 1, TIMEZONE) !== day) return t
  }
  return utcMidnight
}

// Clé commercial de la personne connectée (null sans fiche : lecteur)
export function actorKey(actor: Actor): string | null {
  return actor.fiche ? commercialKey(actor.fiche.email, actor.fiche.name) : null
}

// Recherche normalisée comme dans le script Lua (minuscules, sans accents)
export function foldQuery(q: string): string {
  return q.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/æ/g, 'ae').toLowerCase().trim()
}

// Filtres reçus dans le corps JSON (POST) : la recherche (nom ou email d'un PS) ne passe jamais
// dans l'adresse de la requête, donc jamais dans les journaux d'accès.
export function parseFilters(body: Record<string, unknown> | null | undefined, actor: Actor): SuiviFilters {
  const sp = { get: (k: string): string | null => (body && body[k] != null ? String(body[k]) : null) }
  const today = parisToday()
  let to = DAY.test(sp.get('to') || '') ? sp.get('to')! : today
  let from = DAY.test(sp.get('from') || '') ? sp.get('from')! : addDays(to, -(DEFAULT_PERIOD_DAYS - 1))
  if (from > to) [from, to] = [to, from]
  if (from < addDays(to, -MAX_PERIOD_DAYS)) from = addDays(to, -MAX_PERIOD_DAYS)
  const own = actorKey(actor)
  // « Mes envois » : activé par défaut pour un commercial, désactivé pour un administrateur ou un lecteur
  const mineParam = sp.get('mine')
  const mine = !!own && (mineParam === null ? actor.role === 'commercial' : mineParam === '1')
  const commercial = mine ? own! : (sp.get('commercial') || '').trim().toLowerCase()
  const statut = (STATUTS as readonly string[]).includes(sp.get('statut') || '') ? sp.get('statut')! : ''
  return {
    from, to,
    fromMs: parisDayStartMs(from),
    toMs: parisDayStartMs(addDays(to, 1)) - 1,
    mine,
    commercial,
    statut,
    formation: (sp.get('formation') || '').trim().slice(0, 300),
    q: (sp.get('q') || '').trim().slice(0, 100),
    page: Math.max(1, parseInt(sp.get('page') || '1') || 1),
  }
}

// Filtres qui obligent à lire les envois (sinon : index + compteurs journaliers)
export function needsEntries(f: SuiviFilters): boolean {
  return !!(f.statut || f.formation || foldQuery(f.q))
}

export interface QueryResult {
  total: number
  ids: string[]
  entries: (Record<string, any> | null)[]
  children: Record<string, Record<string, any>>
  stats?: SuiviStats
  formations?: { key: string; nom: string; count: number }[]
}

function parseMaybe(v: unknown): any {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return null }
}

const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [])

export async function runQuery(f: SuiviFilters, opts: { offset: number; count: number; entries: boolean; facets: boolean }): Promise<QueryResult> {
  const base = f.commercial ? KEYS.byCommercial(f.commercial) : KEYS.emailsIndex
  const raw = await getKv().eval(SUIVI_QUERY_SCRIPT, [base, KEYS.emailsIndex], [
    String(f.fromMs), String(f.toMs), f.statut, f.formation, foldQuery(f.q),
    String(opts.offset), String(opts.count), needsEntries(f) ? '1' : '0', opts.facets ? '1' : '0', opts.entries ? '1' : '0',
  ])
  const out = parseMaybe(raw) || {}
  const children: Record<string, Record<string, any>> = {}
  if (out.children && typeof out.children === 'object') {
    for (const [id, c] of Object.entries(out.children)) { const v = parseMaybe(c); if (v) children[id] = v }
  }
  return {
    total: Number(out.total) || 0,
    ids: asArray(out.ids).map(String),
    entries: asArray(out.entries).map((e) => (e ? parseMaybe(e) : null)),
    children,
    stats: out.stats ? Object.fromEntries(STAT_FIELDS.map((k) => [k, Number(out.stats[k]) || 0])) as SuiviStats : undefined,
    formations: out.formations ? asArray(out.formations).map((x: any) => ({ key: String(x[0]), nom: String(x[1]), count: Number(x[2]) || 0 })) : undefined,
  }
}

// Compteurs journaliers de la période, lus une seule fois : équipe + une ou plusieurs clés commercial
export async function countersFor(from: string, to: string, keys: string[]): Promise<{ team: SuiviStats; byKey: Record<string, SuiviStats> }> {
  const empty = (): SuiviStats => Object.fromEntries(STAT_FIELDS.map((k) => [k, 0])) as SuiviStats
  const team = empty()
  const byKey: Record<string, SuiviStats> = Object.fromEntries(keys.map((k) => [k, empty()]))
  const days: string[] = []
  for (let d = from; d <= to && days.length <= MAX_PERIOD_DAYS + 1; d = addDays(d, 1)) days.push(d)
  if (!days.length) return { team, byKey }
  const pipe = getKv().pipeline()
  for (const d of days) pipe.hgetall(KEYS.statsDay(d))
  const hashes = (await pipe.exec()) as (Record<string, unknown> | null)[]
  for (const h of hashes) {
    if (!h) continue
    for (const f of STAT_FIELDS) {
      team[f] += Number(h[f] || 0)
      for (const k of keys) byKey[k][f] += Number(h[`${f}|${k}`] || 0)
    }
  }
  return { team, byKey }
}

// ─── Base non migrée (schéma antérieur, meta:schema_version ≠ 2) ────────────────
// Calcul de secours : sans compteurs journaliers ni index par commercial, tout est calculé sur les
// envois de la période (emails_index par score), pour que les indicateurs ne soient jamais à zéro.
// Le rattachement nom → clé commercial suit EXACTEMENT la règle de la migration (scripts/migrate-kv.ts) :
// un nom correspond à une seule fiche ET le prénom de la fiche correspond à son email ; sinon « nom:{slug} ».
// Mêmes règles de comptage que les compteurs : mêmes chiffres avant et après migration.

function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

function legacyResolver(fiches: Fiche[]): (e: Record<string, any>) => string {
  const cache = new Map<string, string>()
  return (e) => {
    if (e.commercial_key) return String(e.commercial_key)
    if (e.commercial_email) return String(e.commercial_email).trim().toLowerCase()
    const n = String(e.commercial_name || '').trim()
    if (cache.has(n)) return cache.get(n)!
    const matches = n ? fiches.filter((f) => normalizeName(f.name) === normalizeName(n)) : []
    const m = matches.length === 1 ? matches[0] : null
    const email = (m?.email || '').trim().toLowerCase()
    const firstName = m ? normalizeName(m.name).split(/\s+/)[0] : ''
    const local = normalizeName(email.split('@')[0] || '').split(/[.\-_+]/)[0]
    const key = m && email && firstName && firstName === local ? email : commercialKey('', n)
    cache.set(n, key)
    return key
  }
}

export interface LegacyResult extends QueryResult {
  equipe: SuiviStats
  perso: SuiviStats | null
  vue: SuiviStats
  commerciaux: { key: string; name: string }[]
}

export async function runLegacyQuery(f: SuiviFilters, actor: Actor, opts: { offset: number; count: number; facets: boolean }): Promise<LegacyResult> {
  const kv = getKv()
  const ids = (await kv.zrange(KEYS.emailsIndex, f.toMs, f.fromMs, { byScore: true, rev: true })) as string[]
  const entries: (Record<string, any> | null)[] = []
  for (let i = 0; i < ids.length; i += 500) {
    entries.push(...(await kv.mget<(Record<string, any> | null)[]>(...ids.slice(i, i + 500).map((id) => KEYS.track(id)))))
  }
  const keyOf = legacyResolver(actor.fiches)
  const rows = ids
    .map((id, i) => ({ id, e: entries[i], key: entries[i] ? keyOf(entries[i]!) : '' }))
    .filter((r): r is { id: string; e: Record<string, any>; key: string } => !!r.e && r.e.kind !== 'relance')

  const own = actorKey(actor)
  const base = f.commercial ? rows.filter((r) => r.key === f.commercial) : rows
  const q = foldQuery(f.q)
  const filtered = base.filter(({ e }) =>
    (!f.statut || e.statut === f.statut) &&
    (!f.formation || String(e.formation_numero || '') === f.formation || String(e.formation_nom || '') === f.formation) &&
    (!q || foldQuery(`${e.ps_nom || ''} ${e.ps_email || ''}`).includes(q)))

  const page = opts.count < 0 ? filtered.slice(opts.offset) : filtered.slice(opts.offset, opts.offset + opts.count)
  const childIds = page.map((r) => r.e.relance_id).filter((x): x is string => !!x)
  const children: Record<string, Record<string, any>> = {}
  if (childIds.length) {
    const got = await kv.mget<(Record<string, any> | null)[]>(...childIds.map((id) => KEYS.track(id)))
    childIds.forEach((id, i) => { if (got[i]) children[id] = got[i]! })
  }

  const names = new Map<string, string>()
  for (const r of rows) if (!names.has(r.key)) names.set(r.key, String(r.e.commercial_name || r.key))
  const facets = new Map<string, { key: string; nom: string; count: number }>()
  if (opts.facets) {
    for (const { e } of base) {
      const key = String(e.formation_numero || e.formation_nom || '')
      if (!key) continue
      const cur = facets.get(key) || { key, nom: String(e.formation_nom || key), count: 0 }
      cur.count++
      facets.set(key, cur)
    }
  }
  const stats = (list: typeof rows) => statsFromEntries(list.map((r) => r.e)) as SuiviStats
  return {
    total: filtered.length,
    ids: page.map((r) => r.id),
    entries: page.map((r) => r.e),
    children,
    formations: opts.facets ? Array.from(facets.values()) : undefined,
    equipe: stats(rows),
    perso: own ? stats(rows.filter((r) => r.key === own)) : null,
    vue: stats(filtered),
    commerciaux: Array.from(names.entries()).map(([key, name]) => ({ key, name })),
  }
}
