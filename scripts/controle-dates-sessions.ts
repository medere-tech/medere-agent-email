/**
 * Relevé pour Maylis, en LECTURE SEULE : sessions encore proposées à l'étape 3 (formations actives
 * avec numéro DPC, règle sessionOuverte) dont la date écrite dans le mail ne concorde pas avec le
 * texte « Temps lisible (Webflow) » affiché à l'étape 3 (même contrôle que l'assistant et la relance :
 * webflowDateCheck, lib/session-label.ts). Uniquement des requêtes GET vers Airtable.
 *
 * Usage (Node ≥ 22.18) : node scripts/controle-dates-sessions.ts [--today=AAAA-MM-JJ]
 * Variables lues dans .env.local (ou le fichier pointé par ENV_FILE) : AIRTABLE_BASE_ID, AIRTABLE_TOKEN
 * Sortie : formation, numéro de session, texte Webflow, champs de date Airtable, champ à corriger.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parisDay, sessionOuverte, webflowDateCheck } from '../lib/session-label.ts'

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
const BASE_ID = env.AIRTABLE_BASE_ID
const TOKEN = env.AIRTABLE_TOKEN
if (!BASE_ID || !TOKEN) {
  console.error('Variables manquantes : AIRTABLE_BASE_ID, AIRTABLE_TOKEN')
  process.exit(1)
}
const todayArg = process.argv.slice(2).find((a) => a.startsWith('--today='))?.slice('--today='.length)
const today = todayArg && /^\d{4}-\d{2}-\d{2}$/.test(todayArg) ? todayArg : parisDay()

// Mêmes tables et mêmes champs que lib/airtable.ts
const FORMATIONS = 'tblu6nfUIhTQ1cbgk'
const SESSIONS = 'tblGVEqH7KCo2GlXz'
const F = {
  numero: 'Numéro de session',
  debut: 'Date de début de session',
  fin: 'Date de fin de session',
  cv1: 'Date 1ère soirée CV / Date Présentiel',
  cv2: 'Date 2ème soirée CV',
  webflow: 'Temps lisible (Webflow)',
  formation: "Numéro d'action DPC",
  webflowId: 'webflow_id',
}

type Rec = { id: string; fields: Record<string, any> }

async function getAll(path: string): Promise<Rec[]> {
  const records: Rec[] = []
  let offset: string | undefined
  do {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}${path}${offset ? `&offset=${offset}` : ''}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${await res.text()}`)
    const data = await res.json()
    records.push(...(data.records || []))
    offset = data.offset
  } while (offset)
  return records
}

const fields = (names: string[]) => names.map((f) => `&fields[]=${encodeURIComponent(f)}`).join('')

async function main() {
  const formations = await getAll(
    `/${FORMATIONS}?filterByFormula=${encodeURIComponent('AND({Statut de la formation}="Active", {Numéro d\'action DPC}!="")')}` +
      fields(['Nom de la formation', 'Format'])
  )
  const sessions = await getAll(`/${SESSIONS}?pageSize=100${fields(Object.values(F))}`)

  const rows: string[] = []
  let proposees = 0
  for (const f of formations) {
    const format = String(f.fields['Format'] || '')
    const nom = String(f.fields['Nom de la formation'] || '')
    for (const r of sessions.filter((x) => ((x.fields[F.formation] || []) as string[]).includes(f.id))) {
      const s = {
        numero: String(r.fields[F.numero] || ''),
        date_debut: r.fields[F.debut] || '',
        date_fin: r.fields[F.fin] || '',
        date_cv1: r.fields[F.cv1] || '',
        date_cv2: r.fields[F.cv2] || '',
        webflow_id: r.fields[F.webflowId] || '',
        temps_lisible: r.fields[F.webflow] || '',
      }
      if (!sessionOuverte(s, format, today)) continue
      proposees++
      const check = webflowDateCheck(s, format)
      if (!check) continue
      rows.push([
        `${nom} (${format}) · session ${s.numero} · ${r.id}`,
        `  Texte Webflow    : ${s.temps_lisible}`,
        `  Dates Airtable   : ${F.debut} = ${s.date_debut || '—'} · ${F.fin} = ${s.date_fin || '—'} · ${F.cv1} = ${s.date_cv1 || '—'} · ${F.cv2} = ${s.date_cv2 || '—'}`,
        `  Le mail indiquera : ${check.mail}`,
        `  Champ à corriger : ${check.champs.join(' et ')} (si le site a raison ; sinon, corriger le texte Webflow)`,
      ].join('\n'))
    }
  }

  rows.sort((a, b) => a.localeCompare(b, 'fr'))
  console.log(`Date du jour : ${today} · ${proposees} sessions proposées à l'étape 3 · ${rows.length} discordante(s)\n`)
  console.log(rows.join('\n\n'))
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
