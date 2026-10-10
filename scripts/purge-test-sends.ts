/**
 * Supprime du KV les envois de TEST : ceux dont le PS est le contact HubSpot de test ou
 * l'adresse de test (essais faits au nom de vrais commerciaux avant la mise en place des garde-fous).
 * À lancer en production après --export et avant la migration (voir README, « Déploiement »).
 *
 * Usage (Node ≥ 22.18, exécute le TypeScript sans dépendance) :
 *   node scripts/purge-test-sends.ts --host=<hôte KV>             rapport seul (par défaut)
 *   node scripts/purge-test-sends.ts --host=<hôte KV> --apply     suppression réelle
 * Options : --backup-dir=<dossier> (défaut ./backups, où chercher l'export récent).
 * Variables lues dans .env.local (ou le fichier pointé par ENV_FILE) : KV_REST_API_URL, KV_REST_API_TOKEN
 *
 * Supprimé pour chaque envoi de test : email_track, email_body, email_clicks, send_result, verrous
 * hubspot_note:*, entrées de emails_index / idx:commercial / idx:contact / relances_due, et sa
 * contribution aux compteurs stats:day:* (si l'envoi avait déjà été compté). Anciennes relances
 * relance:* dont le PS est le PS de test : supprimées (et leur entrée legacy:… de relances_due).
 * Les envois vers d'autres PS ne sont jamais touchés. Les Notes HubSpot ne sont pas concernées.
 *
 * Garde-fous : --host doit correspondre à KV_REST_API_URL ; --apply refuse sans export de moins
 * d'une heure pour cet hôte (scripts/migrate-kv.ts --export).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { KEYS, PURGE_SEND_SCRIPT } from '../lib/kv-schema.ts'

// PS de test : fiche HubSpot et adresse de Déthié
const TEST_CONTACT_IDS = ['18421683158']
const TEST_EMAILS = ['dethie@medere.fr']

type Entry = Record<string, any>
type Cmd = (string | number)[]
const EXPORT_MAX_AGE_MS = 60 * 60 * 1000

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
const backupDir = resolve(option('backup-dir') || 'backups')

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function required(name: string): string {
  const v = env[name]
  if (!v) fail(`Variable manquante : ${name}`)
  return v
}

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

async function pipeline(commands: Cmd[]): Promise<any[]> {
  const results: any[] = []
  for (let i = 0; i < commands.length; i += 100) {
    const chunk = commands.slice(i, i + 100)
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
  return Array.from(new Set(keys)).sort()
}

function recentExport(host: string): string | null {
  if (!existsSync(backupDir)) return null
  const files = readdirSync(backupDir).filter((f) => f.startsWith(`kv-export-${host}-`) && f.endsWith('.json')).sort().reverse()
  for (const f of files) {
    try {
      const file = JSON.parse(readFileSync(join(backupDir, f), 'utf8')) as { host: string; exported_at: string }
      if (file.host === host && Date.now() - Date.parse(file.exported_at) < EXPORT_MAX_AGE_MS) return join(backupDir, f)
    } catch {
      // fichier illisible : ignoré
    }
  }
  return null
}

function parse(raw: unknown): Entry | null {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as Entry)
  } catch {
    return null
  }
}

const isTestPs = (contactId: unknown, email: unknown) =>
  TEST_CONTACT_IDS.includes(String(contactId || '')) || TEST_EMAILS.includes(String(email || '').trim().toLowerCase())

async function main(): Promise<void> {
  const host = option('host')
  if (!host) fail('Option obligatoire : --host=<hôte de la base KV>')
  const actual = new URL(required('KV_REST_API_URL')).host
  if (actual !== host) fail(`REFUS : KV_REST_API_URL pointe sur ${actual}, pas sur ${host}.`)
  const apply = flag('apply')
  if (apply) {
    const backup = recentExport(host)
    if (!backup) fail(`REFUS : aucun export de moins d'une heure pour ${host} dans ${backupDir}. Lancer d'abord scripts/migrate-kv.ts --export.`)
    console.log(`Export de sauvegarde : ${backup}`)
  }
  console.log(apply ? '=== SUPPRESSION ===\n' : '=== RAPPORT SEUL : aucune modification (ajouter --apply pour supprimer) ===\n')
  console.log(`PS de test : contact(s) ${TEST_CONTACT_IDS.join(', ')} ; adresse(s) ${TEST_EMAILS.join(', ')}\n`)

  // 1. Envois
  const trackKeys = await scan('email_track:*')
  const raws = await pipeline(trackKeys.map((k) => ['GET', k]))
  const targets: { id: string; entry: Entry }[] = []
  let kept = 0
  trackKeys.forEach((key, i) => {
    const entry = parse(raws[i])
    if (!entry) return
    if (isTestPs(entry.contact_id, entry.ps_email)) targets.push({ id: key.slice('email_track:'.length), entry })
    else kept++
  })

  const byCommercial = new Map<string, number>()
  for (const { entry } of targets) byCommercial.set(entry.commercial_name || '?', (byCommercial.get(entry.commercial_name || '?') || 0) + 1)
  console.log(`Envois : ${trackKeys.length} au total, ${targets.length} vers le PS de test, ${kept} vers d'autres PS (conservés).`)
  for (const [name, n] of Array.from(byCommercial.entries()).sort((a, b) => b[1] - a[1])) console.log(`  ${name.padEnd(28)} ${n} envoi(s)`)
  for (const { id, entry } of targets) {
    console.log(`  - ${id}  ${String(entry.sent_at || '').slice(0, 16)}  ${entry.commercial_name || '?'}  « ${entry.sujet || ''} »${entry.v === 2 ? '  (compté)' : ''}`)
  }

  // 2. Anciennes relances relance:*
  const relanceKeys = await scan('relance:*')
  const relanceRaws = await pipeline(relanceKeys.map((k) => ['GET', k]))
  const relanceTargets = relanceKeys.filter((_, i) => {
    const r = parse(relanceRaws[i])
    return !!r && isTestPs(r.ps_hubspot_id, r.ps_email)
  })
  console.log(`\nAnciennes relances : ${relanceKeys.length} clé(s) relance:*, ${relanceTargets.length} pour le PS de test${relanceTargets.length ? ' :' : '.'}`)
  for (const k of relanceTargets) console.log(`  - ${k}`)

  if (!apply) {
    console.log(`\nAucune modification. ${targets.length} envoi(s) et ${relanceTargets.length} ancienne(s) relance(s) seraient supprimés.`)
    return
  }

  const commands: Cmd[] = targets.map(({ id, entry }) => [
    'EVAL', PURGE_SEND_SCRIPT, 11,
    KEYS.track(id), KEYS.statsDay(entry.sent_day || '-'), KEYS.emailsIndex,
    KEYS.byCommercial(entry.commercial_key || '-'), KEYS.byContact(String(entry.contact_id || '-')), KEYS.relancesDue,
    KEYS.body(id), KEYS.clicks(id), KEYS.sendResult(id), KEYS.noteLock(id, 'opened'), KEYS.noteLock(id, 'clicked'),
    id,
  ])
  for (const k of relanceTargets) {
    commands.push(['DEL', k], ['ZREM', KEYS.relancesDue, `legacy:${k}`])
  }
  const results = await pipeline(commands)
  const decremented = results.slice(0, targets.length).reduce((sum: number, r) => sum + Math.max(Number(r), 0), 0)
  console.log(`\nSuppression terminée : ${targets.length} envoi(s) (${decremented} compteur(s) décompté(s)), ${relanceTargets.length} ancienne(s) relance(s).`)
  console.log('Contrôle conseillé : node scripts/migrate-kv.ts --host=<hôte> --verify')
}

main().catch((e: unknown) => {
  console.error('ERREUR', e instanceof Error ? e.message : e)
  process.exit(1)
})
