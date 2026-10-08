/**
 * Migration des données KV vers le schéma v2 (compteurs journaliers, index, relances_due).
 *
 * Usage (Node ≥ 22.18, exécute le TypeScript sans dépendance) :
 *   node scripts/migrate-kv.ts --host=<hôte> --export                 sauvegarde complète (JSON horodaté)
 *   node scripts/migrate-kv.ts --host=<hôte> --dry-run                rapport, aucune écriture
 *   node scripts/migrate-kv.ts --host=<hôte>                          migration réelle
 *   node scripts/migrate-kv.ts --host=<hôte> --verify                 contrôle compteurs / faits (aucune écriture)
 *   node scripts/migrate-kv.ts --host=<hôte> --restore=<fichier>      plan de restauration (aucune écriture)
 *   node scripts/migrate-kv.ts --host=<hôte> --restore=<fichier> --confirm   restauration réelle
 *
 * Options : --backup-dir=<dossier> (défaut ./backups, ignoré par git).
 * Variables lues dans .env.local (ou le fichier pointé par ENV_FILE) :
 *   KV_REST_API_URL, KV_REST_API_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TOKEN (migration et --dry-run)
 *
 * Garde-fous :
 *   - --host doit être égal à l'hôte de KV_REST_API_URL, sinon refus.
 *   - La migration réelle refuse de tourner sans export de moins d'une heure pour cet hôte.
 *   - Idempotente : une entrée déjà en v2 est ignorée ; relancer la migration ne change rien.
 *   - La restauration remet la base dans l'état de l'export : les clés exportées sont réécrites
 *     (valeur et TTL restant au moment de l'export) et les clés créées depuis sont supprimées.
 *     Les écritures faites entre l'export et la restauration sont donc perdues.
 *
 * Correspondance nom → email des anciens envois (qui ne stockaient que le nom) : un nom n'est
 * rattaché à un email que s'il correspond à une seule fiche Commerciaux ET que le prénom de la
 * fiche correspond à l'email (ex. « Sarah Smadja » → sarah.s@). Sinon : clé "nom:{slug}",
 * listée dans le rapport pour validation.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { EMAIL_BODY_TTL_DAYS, RETENTION_DAYS, TIMEZONE } from '../lib/config.ts'
import {
  ATTACH_RELANCE_SCRIPT,
  KEYS,
  MIGRATE_SCRIPT,
  SCHEMA_VERSION,
  STAT_FIELDS,
  dayInTimezone,
  dayStartMs,
  slugify,
  statsExpireAt,
} from '../lib/kv-schema.ts'

type Cmd = (string | number)[]
type Entry = Record<string, any>

const AIRTABLE_COMMERCIAUX = 'tblaDpXcgiNZfcJiO'
const EXPORT_MAX_AGE_MS = 60 * 60 * 1000
const RELANCE_MATCH_WINDOW_MS = 5 * 60 * 1000
const BATCH = 100

// ─── Environnement et arguments ───────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const file = resolve(process.env.ENV_FILE || '.env.local')
  const fromFile = existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
          .map((l) => {
            const i = l.indexOf('=')
            return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]
          })
      )
    : {}
  return { ...fromFile, ...(process.env as Record<string, string>) }
}

const env = loadEnv()
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

function required(name: string): string {
  const v = env[name]
  if (!v) fail(`Variable manquante : ${name}`)
  return v
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const backupDir = resolve(option('backup-dir') || 'backups')

function assertHost(): string {
  const expected = option('host')
  if (!expected) fail('Option obligatoire : --host=<hôte de la base KV> (ex. close-imp-209245.upstash.io)')
  const actual = new URL(required('KV_REST_API_URL')).host
  if (actual !== expected) fail(`REFUS : KV_REST_API_URL pointe sur ${actual}, pas sur ${expected}.`)
  return actual
}

// ─── Client REST Upstash minimal ──────────────────────────────────────────────
async function kv(...command: Cmd): Promise<any> {
  const res = await fetch(required('KV_REST_API_URL'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${required('KV_REST_API_TOKEN')}` },
    body: JSON.stringify(command.map(String)),
  })
  const json = (await res.json()) as { result?: unknown; error?: string }
  if (json.error) throw new Error(json.error)
  return json.result
}

// Exécute des commandes par paquets via /pipeline ; lève à la première erreur
async function pipeline(commands: Cmd[]): Promise<any[]> {
  const results: any[] = []
  for (let i = 0; i < commands.length; i += BATCH) {
    const chunk = commands.slice(i, i + BATCH)
    const res = await fetch(`${required('KV_REST_API_URL')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${required('KV_REST_API_TOKEN')}` },
      body: JSON.stringify(chunk.map((c) => c.map(String))),
    })
    const json = (await res.json()) as { result?: unknown; error?: string }[] | { error: string }
    if (!Array.isArray(json)) throw new Error(json.error)
    json.forEach((r, j) => {
      if (r.error) throw new Error(`${chunk[j][0]} ${chunk[j][1] ?? ''} : ${r.error}`)
      results.push(r.result)
    })
  }
  return results
}

async function scan(pattern: string): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = (await kv('SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000)) as [string, string[]]
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  return Array.from(new Set(keys))
}

// ─── Export / restauration ────────────────────────────────────────────────────
interface ExportedKey {
  key: string
  type: string
  pttl: number
  value: unknown
}
interface ExportFile {
  host: string
  exported_at: string
  key_count: number
  keys: ExportedKey[]
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

async function exportAll(host: string): Promise<void> {
  const exportedAt = new Date()
  const keys = (await scan('*')).sort()
  const meta = await pipeline(keys.flatMap((k) => [['TYPE', k], ['PTTL', k]]))
  const readCmd = (key: string, type: string): Cmd | null => {
    if (type === 'string') return ['GET', key]
    if (type === 'hash') return ['HGETALL', key]
    if (type === 'zset') return ['ZRANGE', key, 0, -1, 'WITHSCORES']
    if (type === 'set') return ['SMEMBERS', key]
    if (type === 'list') return ['LRANGE', key, 0, -1]
    return null
  }
  const items = keys.map((key, i) => ({ key, type: String(meta[2 * i]), pttl: Number(meta[2 * i + 1]) }))
  const unsupported = items.filter((x) => x.type !== 'none' && !readCmd(x.key, x.type))
  if (unsupported.length) fail(`Types non pris en charge : ${unsupported.map((x) => `${x.key} (${x.type})`).join(', ')}`)
  const present = items.filter((x) => x.type !== 'none')
  const values = await pipeline(present.map((x) => readCmd(x.key, x.type)!))

  const file: ExportFile = {
    host,
    exported_at: exportedAt.toISOString(),
    key_count: present.length,
    keys: present.map((x, i) => ({ ...x, value: values[i] })),
  }
  mkdirSync(backupDir, { recursive: true })
  const path = join(backupDir, `kv-export-${host}-${stamp(exportedAt)}.json`)
  writeFileSync(path, JSON.stringify(file))
  const byType = present.reduce<Record<string, number>>((acc, x) => ((acc[x.type] = (acc[x.type] || 0) + 1), acc), {})
  console.log(`Export : ${present.length} clé(s) ${JSON.stringify(byType)}`)
  console.log(`Fichier : ${path}`)
  console.log('Contient des données personnelles (noms et emails des PS) : à conserver hors du dépôt et à supprimer après usage.')
}

function readExport(path: string): ExportFile {
  const file = JSON.parse(readFileSync(path, 'utf8')) as ExportFile
  if (!file.host || !file.exported_at || !Array.isArray(file.keys)) fail(`Fichier d'export invalide : ${path}`)
  return file
}

function recentExport(host: string): string | null {
  if (!existsSync(backupDir)) return null
  const candidates = readdirSync(backupDir)
    .filter((f) => f.startsWith(`kv-export-${host}-`) && f.endsWith('.json'))
    .map((f) => join(backupDir, f))
  for (const path of candidates.sort().reverse()) {
    try {
      const file = readExport(path)
      if (file.host === host && Date.now() - Date.parse(file.exported_at) < EXPORT_MAX_AGE_MS) return path
    } catch {
      // fichier illisible : ignoré
    }
  }
  return null
}

async function restore(host: string, path: string, confirm: boolean): Promise<void> {
  const file = readExport(path)
  if (file.host !== host) fail(`REFUS : l'export ${path} provient de ${file.host}, pas de ${host}.`)
  const exported = new Set(file.keys.map((k) => k.key))
  const current = await scan('*')
  const toDelete = current.filter((k) => !exported.has(k)).sort()

  console.log(`Export du ${file.exported_at} : ${file.keys.length} clé(s) à réécrire.`)
  console.log(`${toDelete.length} clé(s) créée(s) depuis l'export, à supprimer${toDelete.length ? ' :' : '.'}`)
  for (const k of toDelete.slice(0, 50)) console.log(`  - ${k}`)
  if (toDelete.length > 50) console.log(`  … et ${toDelete.length - 50} autre(s)`)
  if (!confirm) {
    console.log('\nAucune écriture. Ajouter --confirm pour restaurer.')
    return
  }

  const commands: Cmd[] = []
  for (const k of file.keys) {
    commands.push(['DEL', k.key])
    const v = k.value as any
    if (k.type === 'string') commands.push(['SET', k.key, v])
    else if (k.type === 'hash' && v.length) commands.push(['HSET', k.key, ...v])
    else if (k.type === 'zset' && v.length) {
      const pairs: Cmd = []
      for (let i = 0; i < v.length; i += 2) pairs.push(v[i + 1], v[i])
      commands.push(['ZADD', k.key, ...pairs])
    } else if (k.type === 'set' && v.length) commands.push(['SADD', k.key, ...v])
    else if (k.type === 'list' && v.length) commands.push(['RPUSH', k.key, ...v])
    if (k.pttl > 0) commands.push(['PEXPIRE', k.key, k.pttl])
  }
  for (const k of toDelete) commands.push(['DEL', k])
  await pipeline(commands)
  console.log(`Restauration terminée : ${file.keys.length} clé(s) réécrite(s), ${toDelete.length} supprimée(s).`)
}

// ─── Correspondance nom → email (Airtable) ────────────────────────────────────
interface Fiche { name: string; email: string; statut: string }

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

async function loadCommerciaux(): Promise<Fiche[]> {
  const fiches: Fiche[] = []
  let offset = ''
  do {
    const url = `https://api.airtable.com/v0/${required('AIRTABLE_BASE_ID')}/${AIRTABLE_COMMERCIAUX}` +
      `?pageSize=100&fields[]=hubspot_name&fields[]=email&fields[]=Statut${offset ? `&offset=${offset}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${required('AIRTABLE_TOKEN')}` } })
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { records: { fields: Record<string, string> }[]; offset?: string }
    for (const r of json.records) {
      fiches.push({ name: (r.fields.hubspot_name || '').trim(), email: (r.fields.email || '').trim().toLowerCase(), statut: r.fields.Statut || '' })
    }
    offset = json.offset || ''
  } while (offset)
  return fiches
}

// Le prénom de la fiche correspond-il à l'email ? (premier segment de la partie locale)
function nameMatchesEmail(name: string, email: string): boolean {
  const firstName = normalize(name).split(/\s+/)[0]
  const local = normalize(email.split('@')[0] || '').split(/[.\-_+]/)[0]
  return !!firstName && firstName === local
}

interface Resolution { key: string; email: string | null; reason: string }

function resolver(fiches: Fiche[]) {
  const cache = new Map<string, Resolution>()
  return (name: string): Resolution => {
    const n = (name || '').trim()
    if (cache.has(n)) return cache.get(n)!
    const matches = fiches.filter((f) => normalize(f.name) === normalize(n) && n)
    let r: Resolution
    if (matches.length === 1 && matches[0].email && nameMatchesEmail(matches[0].name, matches[0].email)) {
      r = { key: matches[0].email, email: matches[0].email, reason: 'ok' }
    } else {
      const reason = !n ? 'nom vide'
        : matches.length === 0 ? 'absent de la table Commerciaux'
        : matches.length > 1 ? `${matches.length} fiches portent ce nom`
        : !matches[0].email ? 'fiche sans email'
        : `le nom ne correspond pas à l'email ${matches[0].email}`
      r = { key: `nom:${slugify(n) || 'inconnu'}`, email: null, reason }
    }
    cache.set(n, r)
    return r
  }
}

// ─── Migration ────────────────────────────────────────────────────────────────
function isset(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '' && v !== false
}

// Mêmes règles que MIGRATE_SCRIPT, pour le rapport --dry-run
function contributions(e: Entry): Record<string, number> {
  const opened = isset(e.first_opened_at) || isset(e.opened_at) || isset(e.first_clicked_at) || isset(e.clicked_at)
  const clicked = isset(e.first_clicked_at) || isset(e.clicked_at)
  const complained = isset(e.complained_at) || e.statut === 'plainte'
  const rank: Record<string, number> = { 'envoyé': 0, 'délivré': 1, 'ouvert': 2, 'cliqué': 3 }
  const r = rank[e.statut] ?? 0
  return {
    sent: 1,
    delivered: isset(e.delivered_at) || opened || Number(e.auto_click_count) > 0 || (r >= 1 && r <= 3) || complained ? 1 : 0,
    opened: opened ? 1 : 0,
    clicked: clicked ? 1 : 0,
    bounced: isset(e.bounced_at) || e.statut === 'bounce' ? 1 : 0,
    complained: complained ? 1 : 0,
  }
}

async function migrate(host: string, dryRun: boolean): Promise<void> {
  if (!dryRun) {
    const backup = recentExport(host)
    if (!backup) fail(`REFUS : aucun export de moins d'une heure pour ${host} dans ${backupDir}. Lancer d'abord --export.`)
    console.log(`Export de sauvegarde : ${backup}`)
  }
  console.log(dryRun ? '=== DRY-RUN : aucune écriture ===\n' : '=== MIGRATION ===\n')

  const resolveName = resolver(await loadCommerciaux())

  // 1. Envois
  const trackKeys = (await scan('email_track:*')).sort()
  const raws = await pipeline(trackKeys.map((k) => ['GET', k]))
  const ids = trackKeys.map((k) => k.slice('email_track:'.length))
  const scores = await pipeline(ids.map((id) => ['ZSCORE', KEYS.emailsIndex, id]))
  const entries: { id: string; entry: Entry; score: number }[] = []
  const unreadable: string[] = []
  ids.forEach((id, i) => {
    try {
      const entry = typeof raws[i] === 'string' ? JSON.parse(raws[i]) : raws[i]
      const fromSent = Date.parse(entry?.sent_at || '')
      const score = Number.isFinite(fromSent) ? fromSent : Number(scores[i])
      if (!entry || !Number.isFinite(score)) throw new Error('date d\'envoi absente')
      entries.push({ id, entry, score })
    } catch {
      unreadable.push(id)
    }
  })

  const todo = entries.filter((x) => x.entry.v !== 2)
  const perDay = new Map<string, Record<string, number>>()
  const perCommercial = new Map<string, { name: string; count: number; reason: string }>()
  const commands: Cmd[] = []

  for (const { id, entry, score } of todo) {
    const day = dayInTimezone(score, TIMEZONE)
    const known = isset(entry.commercial_email)
    const res = known
      ? { key: String(entry.commercial_email).toLowerCase(), email: entry.commercial_email, reason: 'ok' }
      : resolveName(entry.commercial_name || '')
    const name = (entry.commercial_name || '').trim()

    const c = contributions(entry)
    const agg = perDay.get(day) || { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 }
    for (const f of Object.keys(agg)) agg[f] += c[f]
    perDay.set(day, agg)
    const pc = perCommercial.get(res.key) || { name, count: 0, reason: res.reason }
    pc.count++
    perCommercial.set(res.key, pc)

    const contact = isset(entry.contact_id) ? String(entry.contact_id) : ''
    commands.push([
      'EVAL', MIGRATE_SCRIPT, 8,
      KEYS.track(id), KEYS.emailsIndex, KEYS.byCommercial(res.key), KEYS.byContact(contact || '-'),
      KEYS.statsDay(day), KEYS.commerciaux, KEYS.noteLock(id, 'opened'), KEYS.noteLock(id, 'clicked'),
      id, score, res.key, name, statsExpireAt(day, RETENTION_DAYS), day, contact ? '1' : '0',
    ])
  }

  console.log(`Envois : ${entries.length} au total, ${entries.length - todo.length} déjà en v2, ${todo.length} à migrer` +
    (unreadable.length ? `, ${unreadable.length} illisible(s) ignoré(s) : ${unreadable.join(', ')}` : ''))
  if (todo.length) {
    const days = Array.from(perDay.keys()).sort()
    console.log(`\nCompteurs journaliers à ajouter (${days.length} jour(s), du ${days[0]} au ${days[days.length - 1]}) :`)
    console.log('  jour         envoyés délivrés ouverts cliqués bounces plaintes')
    for (const d of days) {
      const a = perDay.get(d)!
      console.log(`  ${d}   ${[a.sent, a.delivered, a.opened, a.clicked, a.bounced, a.complained].map((n) => String(n).padStart(7)).join(' ')}`)
    }
    console.log('\nCommerciaux :')
    for (const [key, pc] of Array.from(perCommercial.entries()).sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${key.padEnd(30)} ${String(pc.count).padStart(5)} envoi(s)  « ${pc.name} »`)
    }
    const toValidate = Array.from(perCommercial.entries()).filter(([k]) => k.startsWith('nom:'))
    if (toValidate.length) {
      console.log('\nÀ VALIDER — noms non rattachés à un email (clé nom:{slug}) :')
      for (const [key, pc] of toValidate) console.log(`  « ${pc.name} » → ${key} (${pc.count} envoi(s)) : ${pc.reason}`)
    }
  }

  // 2. Anciennes relances relance:{ts}
  const relanceKeys = (await scan('relance:*')).sort()
  const relanceRaws = await pipeline(relanceKeys.map((k) => ['GET', k]))
  const today = dayInTimezone(Date.now(), TIMEZONE)
  const matched: string[] = []
  const orphans: string[] = []
  relanceKeys.forEach((key, i) => {
    let r: Entry
    try {
      r = typeof relanceRaws[i] === 'string' ? JSON.parse(relanceRaws[i]) : relanceRaws[i]
    } catch {
      orphans.push(`${key} (illisible)`)
      return
    }
    const due = String(r.relance_at || '')
    const late = due && due < today ? ' — échéance dépassée, sera rattrapée' : ''
    const sentMs = Date.parse(r.sent_at || '')
    const candidates = entries.filter(({ entry, score }) =>
      String(entry.ps_email || '').toLowerCase() === String(r.ps_email || '').toLowerCase() &&
      entry.sujet === r.sujet &&
      Number.isFinite(sentMs) && Math.abs(score - sentMs) <= RELANCE_MATCH_WINDOW_MS)
    if (candidates.length === 1 && due) {
      const { id, score } = candidates[0]
      const bodyTtl = Math.floor((score + EMAIL_BODY_TTL_DAYS * 86400000 - Date.now()) / 1000)
      const fields = {
        ps_rpps: r.ps_rpps || '',
        formation_numero: r.formation_numero || '',
        commercial_slack_id: r.commercial_slack_id || '',
      }
      commands.push([
        'EVAL', ATTACH_RELANCE_SCRIPT, 4,
        KEYS.track(id), KEYS.relancesDue, key, KEYS.body(id),
        id, dayStartMs(due), JSON.stringify(fields), bodyTtl > 0 && r.corps ? JSON.stringify({ corps: r.corps }) : '', Math.max(bodyTtl, 1), due,
      ])
      matched.push(`${key} → ${id} (échéance ${due})${late}`)
    } else {
      // Non rattachée : planifiée telle quelle, le cron lira l'ancienne clé (gardée jusqu'à son expiration)
      if (due) commands.push(['ZADD', KEYS.relancesDue, dayStartMs(due), `legacy:${key}`])
      const why = !due ? 'sans date de relance' : candidates.length === 0 ? 'aucun envoi correspondant' : `${candidates.length} envois correspondants`
      orphans.push(`${key} (${why}, échéance ${due || '?'})${late}`)
    }
  })
  console.log(`\nAnciennes relances : ${relanceKeys.length} clé(s) relance:*`)
  for (const m of matched) console.log(`  rattachée : ${m}`)
  for (const o of orphans) console.log(`  non rattachée, planifiée en legacy : ${o}`)

  if (dryRun) {
    console.log(`\n${commands.length} écriture(s) prévue(s). Aucune écriture effectuée.`)
    return
  }

  const results = await pipeline(commands)
  const migrated = results.filter((r, i) => commands[i][1] === MIGRATE_SCRIPT && Number(r) === 1).length
  await kv('SET', KEYS.schemaVersion, SCHEMA_VERSION)
  console.log(`\nMigration terminée : ${migrated} envoi(s) migré(s), ${matched.length} relance(s) rattachée(s), ` +
    `${orphans.length} relance(s) en legacy. ${KEYS.schemaVersion} = ${SCHEMA_VERSION}.`)
}

// ─── Vérification (aucune écriture) ───────────────────────────────────────────
// Recalcule les compteurs attendus à partir des marqueurs counted_* de chaque envoi v2
// et les compare aux hash stats:day:* ; contrôle aussi que chaque fait (ouvert, cliqué…)
// est compté exactement une fois. Exit 1 s'il y a un écart.
async function verify(): Promise<void> {
  console.log('=== VÉRIFICATION : aucune écriture ===\n')
  const trackKeys = await scan('email_track:*')
  const raws = await pipeline(trackKeys.map((k) => ['GET', k]))
  const expected = new Map<string, Map<string, number>>()
  const incoherent: string[] = []
  let v2 = 0
  let legacy = 0
  const bump = (day: string, field: string) => {
    const h = expected.get(day) || new Map<string, number>()
    h.set(field, (h.get(field) || 0) + 1)
    expected.set(day, h)
  }

  trackKeys.forEach((key, i) => {
    let e: Entry
    try {
      e = typeof raws[i] === 'string' ? JSON.parse(raws[i]) : raws[i]
    } catch {
      incoherent.push(`${key} : illisible`)
      return
    }
    if (e.v !== 2) {
      legacy++
      return
    }
    v2++
    const prefix = e.kind === 'relance' ? 'relance_' : ''
    const facts: Record<string, boolean> = {
      sent: true,
      delivered: isset(e.delivered_at) || isset(e.first_opened_at) || isset(e.first_clicked_at) || Number(e.auto_click_count) > 0 ||
        ['délivré', 'ouvert', 'cliqué', 'plainte'].includes(e.statut) || isset(e.complained_at),
      opened: isset(e.first_opened_at) || isset(e.first_clicked_at),
      clicked: isset(e.first_clicked_at),
      bounced: isset(e.bounced_at) || e.statut === 'bounce',
      complained: isset(e.complained_at) || e.statut === 'plainte',
    }
    for (const field of STAT_FIELDS) {
      const counted = e[`counted_${field}`] === true
      if (counted !== facts[field]) {
        incoherent.push(`${key} : ${field} ${facts[field] ? 'constaté mais non compté' : 'compté sans fait constaté'}`)
      }
      if (counted) {
        bump(e.sent_day, prefix + field)
        if (e.commercial_key) bump(e.sent_day, `${prefix}${field}|${e.commercial_key}`)
      }
    }
  })

  const statKeys = await scan('stats:day:*')
  const hashes = await pipeline(statKeys.map((k) => ['HGETALL', k]))
  const actual = new Map<string, Map<string, number>>()
  statKeys.forEach((k, i) => {
    const flat = (hashes[i] || []) as string[]
    const h = new Map<string, number>()
    for (let j = 0; j < flat.length; j += 2) h.set(flat[j], Number(flat[j + 1]))
    actual.set(k.slice('stats:day:'.length), h)
  })

  const gaps: string[] = []
  for (const day of Array.from(new Set(Array.from(expected.keys()).concat(Array.from(actual.keys()))))) {
    const exp = expected.get(day) || new Map<string, number>()
    const act = actual.get(day) || new Map<string, number>()
    for (const field of Array.from(new Set(Array.from(exp.keys()).concat(Array.from(act.keys()))))) {
      const a = act.get(field) || 0
      const x = exp.get(field) || 0
      if (a !== x) gaps.push(`stats:day:${day} ${field} : compteur ${a}, attendu ${x}`)
    }
  }

  console.log(`Envois : ${v2} en v2, ${legacy} non migré(s) (non comptés par construction).`)
  console.log(`Jours de compteurs : ${actual.size} existant(s), ${expected.size} attendu(s).`)
  console.log(`Écarts de compteurs : ${gaps.length}`)
  for (const g of gaps.slice(0, 100)) console.log(`  - ${g}`)
  console.log(`Incohérences fait / comptage : ${incoherent.length}`)
  for (const x of incoherent.slice(0, 100)) console.log(`  - ${x}`)
  if (gaps.length || incoherent.length) process.exit(1)
  console.log('\nOK : chaque fait est compté exactement une fois.')
}

async function main(): Promise<void> {
  const host = assertHost()
  const restorePath = option('restore')
  if (flag('verify')) return verify()
  if (flag('export')) return exportAll(host)
  if (restorePath) return restore(host, resolve(restorePath), flag('confirm'))
  return migrate(host, flag('dry-run'))
}

main().catch((e: unknown) => {
  console.error('ERREUR', e instanceof Error ? e.message : e)
  process.exit(1)
})
