/**
 * Supprime les Notes HubSpot « Email ouvert » / « Email cliqué » créées en double par l'agent
 * pour un même mail (avant la phase 1, le webhook créait une Note par événement).
 *
 * Usage (Node ≥ 22.18, exécute le TypeScript sans dépendance) :
 *   node scripts/dedupe-hubspot-notes.ts --host=<hôte KV>                      rapport seul (par défaut)
 *   node scripts/dedupe-hubspot-notes.ts --host=<hôte KV> --apply              archive les doublons
 * Options :
 *   --contact=<id>            un seul contact HubSpot (sinon : tous les contacts présents dans le KV)
 *   --subject-prefix=<texte>  seulement les mails dont le sujet commence par ce texte (tests)
 * Variables lues dans .env.local (ou le fichier pointé par ENV_FILE) :
 *   KV_REST_API_URL, KV_REST_API_TOKEN, HUBSPOT_TOKEN
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
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

// ─── HubSpot ──────────────────────────────────────────────────────────────────
async function hs(path: string, init: RequestInit = {}, attempt = 0): Promise<any> {
  const res = await fetch(`${HS}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${required('HUBSPOT_TOKEN')}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
    return hs(path, init, attempt + 1)
  }
  if (!res.ok) throw new Error(`HubSpot ${res.status} ${path} : ${(await res.text()).slice(0, 300)}`)
  return res.status === 204 ? null : res.json()
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

interface Note { id: string; body: string; created: string }

async function readNotes(ids: string[]): Promise<Note[]> {
  const notes: Note[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const res = await hs('/crm/v3/objects/notes/batch/read', {
      method: 'POST',
      body: JSON.stringify({ inputs: ids.slice(i, i + 100).map((id) => ({ id })), properties: ['hs_note_body', 'hs_createdate', 'hs_timestamp'] }),
    })
    for (const r of res.results || []) {
      notes.push({ id: String(r.id), body: r.properties.hs_note_body || '', created: r.properties.hs_createdate || r.properties.hs_timestamp || r.createdAt || '' })
    }
  }
  return notes
}

async function archiveNotes(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    await hs('/crm/v3/objects/notes/batch/archive', { method: 'POST', body: JSON.stringify({ inputs: ids.slice(i, i + 100).map((id) => ({ id })) }) })
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim()
}

// ─── Programme ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const host = option('host')
  if (!host) fail('Option obligatoire : --host=<hôte de la base KV>')
  const actual = new URL(required('KV_REST_API_URL')).host
  if (actual !== host) fail(`REFUS : KV_REST_API_URL pointe sur ${actual}, pas sur ${host}.`)
  const apply = flag('apply')
  const prefix = option('subject-prefix') || ''
  const onlyContact = option('contact')

  console.log(apply ? '=== APPLICATION : les doublons seront archivés ===\n' : '=== RAPPORT SEUL : aucune modification (ajouter --apply pour archiver) ===\n')
  const mails = await mailsByContact()
  const contacts = onlyContact ? [onlyContact] : Array.from(mails.keys()).sort()
  console.log(`${contacts.length} contact(s) à examiner${prefix ? `, sujets commençant par « ${prefix} »` : ''}.\n`)

  let totalArchived = 0
  let totalAmbiguous = 0
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
    const toArchive: string[] = []
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
      toArchive.push(...dups.map((d) => d.id))
      lines.push(`  ${g.type} « ${g.sujet} » (${g.commercial}) : ${g.notes.length} Notes → garde ${keep.id} (${keep.created}), archive ${dups.map((d) => d.id).join(', ')}`)
    }

    console.log(`Contact ${contactId} : ${notes.length} Note(s), dont ${agentNotes} ouverture(s)/clic(s) de l'agent${lines.length ? '' : ' — aucun doublon'}`)
    for (const l of lines) console.log(l)
    if (apply && toArchive.length) {
      await archiveNotes(toArchive)
      console.log(`  → ${toArchive.length} Note(s) archivée(s)`)
    }
    totalArchived += toArchive.length
  }

  console.log(`\nTotal : ${totalArchived} doublon(s) ${apply ? 'archivé(s)' : 'à archiver'}, ${totalAmbiguous} cas ambigu(s) non traité(s).`)
}

main().catch((e: unknown) => {
  console.error('ERREUR', e instanceof Error ? e.message : e)
  process.exit(1)
})
