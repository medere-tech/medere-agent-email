/**
 * Supprime les Notes HubSpot « Email ouvert » / « Email cliqué » créées en double par l'agent
 * pour un même mail (avant la phase 1, le webhook créait une Note par événement).
 *
 * Usage (Node ≥ 22.18, exécute le TypeScript sans dépendance) :
 *   node scripts/dedupe-hubspot-notes.ts --host=<hôte KV>                      rapport seul (par défaut)
 *   node scripts/dedupe-hubspot-notes.ts --host=<hôte KV> --apply              sauvegarde, puis archive les doublons
 *   node scripts/dedupe-hubspot-notes.ts --restore=<fichier JSON>              recrée les Notes sauvegardées
 * Options :
 *   --contact=<id>            un seul contact HubSpot (sinon : tous les contacts présents dans le KV)
 *   --subject-prefix=<texte>  seulement les mails dont le sujet commence par ce texte (tests)
 *   --backup-dir=<dossier>    dossier des sauvegardes (défaut ./backups)
 * Variables lues dans .env.local (ou le fichier pointé par ENV_FILE) :
 *   KV_REST_API_URL, KV_REST_API_TOKEN (rapport et --apply), HUBSPOT_TOKEN
 *
 * Règles (aucune exception) :
 *   - Rapport seul par défaut : rien n'est modifié sans --apply. --host doit correspondre au KV.
 *   - Seules les Notes au format exact de l'agent sont prises en compte :
 *       « 👁️ <b>Email ouvert le …</b><br><br><b>Sujet :</b> …<br><b>Commercial :</b> … »
 *       « 🖱️ <b>Email cliqué le …</b>… » ou « 🖱️ <b>Lien cliqué le …</b>… » (libellé créé pendant les tests)
 *     Toute autre Note (saisie à la main, « Email envoyé », etc.) est ignorée.
 *   - Les Notes sont regroupées par contact, type (ouverture / clic), sujet et commercial. Le KV
 *     doit contenir EXACTEMENT un mail à ce contact avec ce sujet et ce commercial : la Note la
 *     plus ancienne est gardée, les autres sont archivées (corbeille HubSpot, récupérables 90 jours).
 *     0 ou plusieurs mails correspondants : cas ambigu, rien n'est touché, signalé dans le rapport.
 *   - Aucun mail n'est supprimé : le script ne touche jamais au KV.
 *
 * Sauvegarde (--apply) : AVANT tout archivage, chaque Note à archiver est enregistrée dans
 * <backup-dir>/notes-archivees-<hôte>-<date>.json (identifiant, contact, contenu, date affichée
 * hs_timestamp, date de création, propriétaire). Le fichier est écrit sur disque, relu et vérifié avant
 * le premier appel d'archivage ; chaque lot archivé y est ensuite marqué (archived_at).
 * Interruption : relancer la même commande (les Notes déjà archivées ne sont plus vues comme des
 * doublons ; les suivantes sont sauvegardées dans un nouveau fichier avant d'être archivées).
 *
 * Restauration (--restore) : recrée chaque Note du fichier avec son contenu, sa date affichée
 * (hs_timestamp), son propriétaire et son association au contact d'origine. HubSpot ne permet de
 * reprendre ni la date de création (hs_createdate) ni l'identifiant : la Note restaurée a un nouvel
 * identifiant, noté dans le fichier (restored_id). Reprise après interruption : relancer la même
 * commande ; une Note déjà restaurée (restored_id, ou Note identique — même contenu, même date — déjà
 * présente sur le contact) n'est jamais recréée.
 *
 * Limites d'appels HubSpot : au plus 8 requêtes par seconde, lots de 100 (lecture, archivage,
 * création), nouvel essai sur 429 (délai Retry-After, sinon délai croissant), et sur erreur 5xx ou
 * réseau pour les lectures et l'archivage (sans effet si répétés). Une création en échec hors 429
 * arrête la restauration, fichier à jour : la relancer reprend sans doublon.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

type Entry = Record<string, any>

const HS = 'https://api.hubapi.com'
const NOTE_RE = /^\s*(?:👁️|🖱️)?\s*<b>(Email ouvert|Email cliqué|Lien cliqué) le ([^<]+)<\/b><br><br><b>Sujet :<\/b> ([\s\S]*?)<br><b>Commercial :<\/b> ([^<]*?)\s*(?:<br>[\s\S]*)?$/

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

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function required(name: string): string {
  const v = env[name]
  if (!v) fail(`Variable manquante : ${name}`)
  return v
}

// ─── KV (lecture seule) ───────────────────────────────────────────────────────
async function kv(...command: (string | number)[]): Promise<any> {
  const res = await fetch(required('KV_REST_API_URL'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${required('KV_REST_API_TOKEN')}` },
    body: JSON.stringify(command.map(String)),
  })
  const json = (await res.json()) as { result?: unknown; error?: string }
  if (json.error) throw new Error(json.error)
  return json.result
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

// Mails du KV par contact : { sujet, commercial }
async function mailsByContact(): Promise<Map<string, { sujet: string; commercial: string }[]>> {
  const keys = await scan('email_track:*')
  const map = new Map<string, { sujet: string; commercial: string }[]>()
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200)
    const values = (await kv('MGET', ...chunk)) as (string | null)[]
    for (const raw of values) {
      if (!raw) continue
      let e: Entry
      try { e = JSON.parse(raw) } catch { continue }
      if (!e.contact_id) continue
      const list = map.get(String(e.contact_id)) || []
      list.push({ sujet: String(e.sujet || '').trim(), commercial: String(e.commercial_name || '').trim() })
      map.set(String(e.contact_id), list)
    }
  }
  return map
}

// ─── HubSpot (débit limité, nouveaux essais) ──────────────────────────────────
const MIN_INTERVAL_MS = 125
const MAX_ATTEMPTS = 6
let lastCall = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// retryable : lecture ou archivage (sans effet si répétés) → nouvel essai aussi sur 5xx et erreur
// réseau. Toujours un nouvel essai sur 429 (la requête n'a pas été traitée par HubSpot).
async function hs(path: string, init: RequestInit = {}, { retryable = true }: { retryable?: boolean } = {}): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    let res: Response
    try {
      res = await fetch(`${HS}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${required('HUBSPOT_TOKEN')}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
      })
    } catch (e: unknown) {
      if (!retryable || attempt >= MAX_ATTEMPTS) throw e
      console.warn(`  (réseau indisponible, nouvel essai ${attempt}/${MAX_ATTEMPTS - 1})`)
      await sleep(1000 * 2 ** (attempt - 1))
      continue
    }
    const retry = res.status === 429 || (retryable && res.status >= 500)
    if (retry && attempt < MAX_ATTEMPTS) {
      const after = Number(res.headers.get('retry-after'))
      const delay = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1)
      console.warn(`  (HubSpot ${res.status}, nouvel essai dans ${Math.round(delay / 1000)} s — ${attempt}/${MAX_ATTEMPTS - 1})`)
      await res.text().catch(() => '')
      await sleep(delay)
      continue
    }
    if (!res.ok) throw new Error(`HubSpot ${res.status} ${path} : ${(await res.text()).slice(0, 300)}`)
    return res.status === 204 ? null : res.json()
  }
}

async function noteIdsOfContact(contactId: string): Promise<string[]> {
  const ids: string[] = []
  let after = ''
  do {
    const page = await hs(`/crm/v4/objects/contacts/${contactId}/associations/notes?limit=500${after ? `&after=${after}` : ''}`)
    for (const r of page.results || []) ids.push(String(r.toObjectId))
    after = page.paging?.next?.after || ''
  } while (after)
  return ids
}

interface Note { id: string; body: string; created: string; timestamp: string; owner: string }

async function readNotes(ids: string[]): Promise<Note[]> {
  const notes: Note[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const res = await hs('/crm/v3/objects/notes/batch/read', {
      method: 'POST',
      body: JSON.stringify({ inputs: ids.slice(i, i + 100).map((id) => ({ id })), properties: ['hs_note_body', 'hs_createdate', 'hs_timestamp', 'hubspot_owner_id'] }),
    })
    for (const r of res.results || []) {
      const p = r.properties || {}
      notes.push({
        id: String(r.id),
        body: p.hs_note_body || '',
        created: p.hs_createdate || p.hs_timestamp || r.createdAt || '',
        timestamp: p.hs_timestamp || p.hs_createdate || r.createdAt || '',
        owner: p.hubspot_owner_id || '',
      })
    }
  }
  return notes
}

// ─── Sauvegarde et restauration ───────────────────────────────────────────────
interface SavedNote {
  id: string
  contact_id: string
  body: string
  hs_timestamp: string
  hs_createdate: string
  owner_id: string
  archived_at?: string
  restored_id?: string
  restored_at?: string
}
interface BackupFile { version: 1; created_at: string; kv_host: string; notes: SavedNote[] }

// Écriture sûre : fichier temporaire écrit sur disque (fsync), puis renommé
function writeBackup(file: string, data: BackupFile): void {
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

function readBackup(file: string): BackupFile {
  if (!existsSync(file)) fail(`Fichier introuvable : ${file}`)
  const data = JSON.parse(readFileSync(file, 'utf8')) as BackupFile
  if (data?.version !== 1 || !Array.isArray(data.notes)) fail(`Fichier de sauvegarde illisible : ${file}`)
  return data
}

// Sauvegarde vérifiée (relue : chaque Note présente, avec son contenu) AVANT tout archivage
function saveBeforeArchive(plan: { note: Note; contactId: string }[], kvHost: string): { file: string; data: BackupFile } {
  const dir = resolve(option('backup-dir') || 'backups')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const file = join(dir, `notes-archivees-${kvHost}-${stamp}.json`)
  const data: BackupFile = {
    version: 1,
    created_at: new Date().toISOString(),
    kv_host: kvHost,
    notes: plan.map(({ note, contactId }) => ({
      id: note.id, contact_id: contactId, body: note.body, hs_timestamp: note.timestamp, hs_createdate: note.created, owner_id: note.owner,
    })),
  }
  writeBackup(file, data)
  const check = readBackup(file)
  const ok = check.notes.length === data.notes.length &&
    data.notes.every((n, i) => !!n.body && !!n.hs_timestamp && check.notes[i].id === n.id && check.notes[i].body === n.body && check.notes[i].contact_id === n.contact_id)
  if (!ok) fail(`REFUS : la sauvegarde ${file} ne correspond pas aux Notes à archiver. Rien n'a été archivé.`)
  console.log(`\nSauvegarde vérifiée : ${file} (${data.notes.length} Note(s))`)
  return { file, data }
}

async function archiveWithBackup(file: string, data: BackupFile): Promise<number> {
  let done = 0
  const pending = data.notes.filter((n) => !n.archived_at)
  for (let i = 0; i < pending.length; i += 100) {
    const batch = pending.slice(i, i + 100)
    await hs('/crm/v3/objects/notes/batch/archive', { method: 'POST', body: JSON.stringify({ inputs: batch.map((n) => ({ id: n.id })) }) })
    const at = new Date().toISOString()
    for (const n of batch) n.archived_at = at
    writeBackup(file, data)
    done += batch.length
    console.log(`  → lot archivé : ${done}/${pending.length}`)
  }
  return done
}

const NOTE_TO_CONTACT = 202 // association HubSpot standard Note → Contact

async function restore(fileArg: string): Promise<void> {
  const file = resolve(fileArg)
  const data = readBackup(file)
  const todo = data.notes.filter((n) => !n.restored_id)
  console.log(`=== RESTAURATION : ${todo.length} Note(s) à recréer sur ${data.notes.length} (${file}) ===\n`)

  // Notes identiques déjà présentes sur le contact (restauration interrompue après la création) : jamais recréées
  const byContact = new Map<string, SavedNote[]>()
  for (const n of todo) byContact.set(n.contact_id, [...(byContact.get(n.contact_id) || []), n])
  const toCreate: SavedNote[] = []
  let already = 0
  for (const [contactId, notes] of Array.from(byContact.entries())) {
    const existing = await readNotes(await noteIdsOfContact(contactId))
    for (const n of notes) {
      const same = existing.find((e) => e.id !== n.id && e.body === n.body && Date.parse(e.timestamp) === Date.parse(n.hs_timestamp))
      if (same) {
        n.restored_id = same.id
        n.restored_at = new Date().toISOString()
        already++
        console.log(`  déjà présente : Note ${n.id} → ${same.id} (contact ${contactId})`)
      } else {
        toCreate.push(n)
      }
    }
  }
  writeBackup(file, data)

  let created = 0
  for (let i = 0; i < toCreate.length; i += 100) {
    const batch = toCreate.slice(i, i + 100)
    const res = await hs('/crm/v3/objects/notes/batch/create', {
      method: 'POST',
      body: JSON.stringify({
        inputs: batch.map((n) => ({
          properties: { hs_note_body: n.body, hs_timestamp: n.hs_timestamp, ...(n.owner_id ? { hubspot_owner_id: n.owner_id } : {}) },
          associations: [{ to: { id: n.contact_id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT }] }],
        })),
      }),
    }, { retryable: false })
    // Les Notes créées sont rapprochées des entrées par contenu et date (l'ordre de la réponse n'est pas garanti)
    const results: any[] = res?.results || []
    const at = new Date().toISOString()
    for (const n of batch) {
      const k = results.findIndex((r) => r.properties?.hs_note_body === n.body && Date.parse(r.properties?.hs_timestamp) === Date.parse(n.hs_timestamp))
      if (k >= 0) {
        n.restored_id = String(results[k].id)
        n.restored_at = at
        results.splice(k, 1)
      }
    }
    writeBackup(file, data)
    created += batch.filter((n) => n.restored_id).length
    if (batch.some((n) => !n.restored_id)) fail('Réponse de HubSpot incomplète : relancer la restauration (les Notes déjà créées sont retrouvées, aucun doublon).')
    console.log(`  → lot restauré : ${created}/${toCreate.length}`)
  }
  for (const n of data.notes) console.log(`  Note ${n.id} (contact ${n.contact_id}, ${n.hs_timestamp}) → ${n.restored_id || 'non restaurée'}`)
  console.log(`\nTotal : ${created} Note(s) recréée(s), ${already} déjà présente(s).`)
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim()
}

// ─── Programme ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const restoreFile = option('restore')
  if (restoreFile) return restore(restoreFile)

  const host = option('host')
  if (!host) fail('Option obligatoire : --host=<hôte de la base KV>')
  const actual = new URL(required('KV_REST_API_URL')).host
  if (actual !== host) fail(`REFUS : KV_REST_API_URL pointe sur ${actual}, pas sur ${host}.`)
  const apply = flag('apply')
  const prefix = option('subject-prefix') || ''
  const onlyContact = option('contact')

  console.log(apply ? '=== APPLICATION : les doublons seront sauvegardés puis archivés ===\n' : '=== RAPPORT SEUL : aucune modification (ajouter --apply pour archiver) ===\n')
  const mails = await mailsByContact()
  const contacts = onlyContact ? [onlyContact] : Array.from(mails.keys()).sort()
  console.log(`${contacts.length} contact(s) à examiner${prefix ? `, sujets commençant par « ${prefix} »` : ''}.\n`)

  let totalAmbiguous = 0
  const plan: { note: Note; contactId: string }[] = []
  for (const contactId of contacts) {
    const notes = await readNotes(await noteIdsOfContact(contactId))
    const groups = new Map<string, { type: string; sujet: string; commercial: string; notes: Note[] }>()
    let agentNotes = 0
    for (const n of notes) {
      const m = NOTE_RE.exec(n.body)
      if (!m) continue
      const type = m[1] === 'Email ouvert' ? 'ouverture' : 'clic'
      const sujet = decodeEntities(m[3])
      const commercial = decodeEntities(m[4])
      if (prefix && !sujet.startsWith(prefix)) continue
      agentNotes++
      const key = `${type}\u0000${sujet}\u0000${commercial}`
      const g = groups.get(key) || { type, sujet, commercial, notes: [] }
      g.notes.push(n)
      groups.set(key, g)
    }

    const lines: string[] = []
    for (const g of Array.from(groups.values())) {
      if (g.notes.length < 2) continue
      const matching = (mails.get(contactId) || []).filter((x) => x.sujet === g.sujet && x.commercial === g.commercial).length
      if (matching !== 1) {
        totalAmbiguous++
        lines.push(`  AMBIGU — ${g.type} « ${g.sujet} » (${g.commercial}) : ${g.notes.length} Notes, ${matching} mail(s) correspondant(s) dans le suivi → rien n'est touché`)
        continue
      }
      g.notes.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id.localeCompare(b.id)))
      const [keep, ...dups] = g.notes
      plan.push(...dups.map((note) => ({ note, contactId })))
      lines.push(`  ${g.type} « ${g.sujet} » (${g.commercial}) : ${g.notes.length} Notes → garde ${keep.id} (${keep.created}), archive ${dups.map((d) => d.id).join(', ')}`)
    }

    console.log(`Contact ${contactId} : ${notes.length} Note(s), dont ${agentNotes} ouverture(s)/clic(s) de l'agent${lines.length ? '' : ' — aucun doublon'}`)
    for (const l of lines) console.log(l)
  }

  // Sauvegarde vérifiée, puis seulement archivage (par lots, chaque lot marqué dans la sauvegarde)
  if (apply && plan.length) {
    const { file, data } = saveBeforeArchive(plan, actual)
    await archiveWithBackup(file, data)
    console.log(`Restauration possible : node scripts/dedupe-hubspot-notes.ts --restore=${file}`)
  }

  console.log(`\nTotal : ${plan.length} doublon(s) ${apply ? 'archivé(s)' : 'à archiver'}, ${totalAmbiguous} cas ambigu(s) non traité(s).`)
}

main().catch((e: unknown) => {
  console.error('ERREUR', e instanceof Error ? e.message : e)
  process.exit(1)
})
