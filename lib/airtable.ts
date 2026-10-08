import { AIRTABLE_CACHE_SECONDS, COMMERCIAL_CACHE_SECONDS } from '@/lib/config'
import { getKv, kvConfigured } from '@/lib/kv'
import type { Fiche } from '@/lib/roles'

const BASE_ID = process.env.AIRTABLE_BASE_ID!
const TOKEN = process.env.AIRTABLE_TOKEN!

// Liste des formations proposées à l'étape 2 (getFormationsActives) :
//   false (comportement actuel, recommandé par Maylis) : formations "Active" avec numéro DPC,
//         qu'elles aient des sessions à venir ou non.
//   true  : en plus, uniquement les formations ayant au moins une session qui démarre après aujourd'hui.
export const FORMATIONS_REQUIRE_FUTURE_SESSION = false

const TABLES = {
  formations: 'tblu6nfUIhTQ1cbgk',
  sessions: 'tblGVEqH7KCo2GlXz',
  clients: 'tbln6mEwZqHPXVylG',
  inscriptions: 'tblTOJHEwCQhibcMM',
  commerciaux: 'tblaDpXcgiNZfcJiO',
}

// fresh: true → pas de cache Next. Obligatoire pour toute requête paginée (voir atAll)
// et pour le cron (les inscriptions doivent être à jour). Sinon, cache de 60 s.
async function at(path: string, { fresh = false }: { fresh?: boolean } = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    ...(fresh ? { cache: 'no-store' as const } : { next: { revalidate: 60 } }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Airtable ${res.status}: ${err}`)
  }
  return res.json()
}

// Charge toutes les pages d'une requête (path doit déjà contenir un "?").
// Jamais de cache, première page comprise : une page 1 servie depuis le cache porte
// un offset expiré côté Airtable → 422 LIST_RECORDS_ITERATOR_NOT_AVAILABLE sur la page 2.
async function atAll(path: string): Promise<any[]> {
  const records: any[] = []
  let offset: string | undefined
  do {
    const offsetParam = offset ? `&offset=${offset}` : ''
    const data = await at(`${path}${offsetParam}`, { fresh: true })
    records.push(...(data.records || []))
    offset = data.offset
  } while (offset)
  return records
}

// Échappe une valeur insérée entre guillemets dans une formule Airtable
function formulaString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Tables lues en entier (formations, sessions) : relire toute la table Sessions prend ~3 s
// (pagination de ~11 pages). Cache en mémoire (instance) puis dans le KV (partagé entre
// instances), AIRTABLE_CACHE_SECONDS. Une modification Airtable apparaît donc dans l'app en
// 5 minutes au plus. Le cron ne passe jamais par ce cache (inscriptions toujours à jour).
const memoryCache = new Map<string, { at: number; value: unknown }>()
const inflight = new Map<string, Promise<unknown>>()

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const ttlMs = AIRTABLE_CACHE_SECONDS * 1000
  const hit = memoryCache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T
  // Plusieurs requêtes simultanées (préchargement + choix de la formation) : un seul chargement
  const pending = inflight.get(key)
  if (pending) return pending as Promise<T>
  const promise = (async () => {
    const kvKey = `cache:airtable:${key}`
    if (kvConfigured()) {
      try {
        const fromKv = await getKv().get<{ at: number; value: T }>(kvKey)
        if (fromKv && Date.now() - fromKv.at < ttlMs) {
          memoryCache.set(key, fromKv)
          return fromKv.value
        }
      } catch (e: any) {
        console.error('[AIRTABLE] Cache KV illisible :', e.message)
      }
    }
    const value = await load()
    const entry = { at: Date.now(), value }
    memoryCache.set(key, entry)
    if (kvConfigured()) {
      try {
        await getKv().set(kvKey, entry, { ex: AIRTABLE_CACHE_SECONDS })
      } catch (e: any) {
        console.error('[AIRTABLE] Cache KV non enregistré :', e.message)
      }
    }
    return value
  })()
  inflight.set(key, promise)
  try {
    return await promise
  } finally {
    inflight.delete(key)
  }
}

// Toutes les sessions (champs utiles seulement), triées par date de début
const SESSION_FIELDS = [
  'session_id', 'Numéro de session', 'Date de début de session', 'Date de fin de session',
  'Date 1ère soirée CV / Date Présentiel', 'Date 2ème soirée CV', "Date limite d'inscription",
  'Temps lisible (Webflow)', "Numéro d'action DPC", 'webflow_id',
]

async function loadAllSessions(): Promise<{ id: string; fields: Record<string, any> }[]> {
  const fields = SESSION_FIELDS.map((f) => `fields[]=${encodeURIComponent(f)}`).join('&')
  const sort = `sort[0][field]=${encodeURIComponent('Date de début de session')}&sort[0][direction]=asc`
  const records = await atAll(`/${TABLES.sessions}?${fields}&${sort}`)
  return records.map((r: any) => ({ id: r.id, fields: r.fields }))
}

function allSessionsCached() {
  return cached('sessions:v1', loadAllSessions)
}

export interface Formation {
  id: string
  nom: string
  numero: string
  format: string
  public: string[]
  statut: string
}

export interface Session {
  id: string
  session_id: string
  numero: string
  date_debut: string
  date_fin: string
  date_cv1: string
  date_cv2: string
  date_limite: string
  temps_lisible: string
  formation_id: string
}

// Toutes les fiches Commerciaux (tous statuts), pour rapprocher la session Google d'une fiche.
// Cache mémoire à durée STRICTE (COMMERCIAL_CACHE_SECONDS) : contrairement au cache Next
// (revalidate), aucune fiche périmée n'est servie au-delà du délai — un commercial passé
// « Plus actif » est bloqué en moins de COMMERCIAL_CACHE_SECONDS.
let fichesCache: { at: number; fiches: Fiche[] } | null = null

export async function getAllFiches(): Promise<Fiche[]> {
  if (fichesCache && Date.now() - fichesCache.at < COMMERCIAL_CACHE_SECONDS * 1000) return fichesCache.fiches
  const records = await atAll(
    `/${TABLES.commerciaux}?fields[]=hubspot_id&fields[]=email&fields[]=phone&fields[]=slack_user_id&fields[]=hubspot_name&fields[]=Statut`
  )
  const fiches: Fiche[] = records.map((r: any) => ({
    id: r.id,
    hubspot_id: r.fields.hubspot_id || '',
    name: r.fields.hubspot_name || '',
    email: r.fields.email || '',
    phone: r.fields.phone || '',
    slack_user_id: r.fields.slack_user_id || '',
    statut: r.fields.Statut || '',
  }))
  fichesCache = { at: Date.now(), fiches }
  return fiches
}

export async function getFormationsActives(): Promise<Formation[]> {
  return cached('formations:v1', loadFormationsActives)
}

async function loadFormationsActives(): Promise<Formation[]> {
  // Formations actives avec numéro DPC (voir FORMATIONS_REQUIRE_FUTURE_SESSION en haut du fichier)
  const formula = encodeURIComponent('AND({Statut de la formation}="Active", {Numéro d\'action DPC}!="")')
  const allFormationRecords = await atAll(
    `/${TABLES.formations}?filterByFormula=${formula}&fields[]=${encodeURIComponent('Nom de la formation')}&fields[]=${encodeURIComponent("Numéro d'action DPC")}&fields[]=${encodeURIComponent('Format')}&fields[]=${encodeURIComponent('Public concerné')}`
  )

  let records = allFormationRecords
  if (FORMATIONS_REQUIRE_FUTURE_SESSION) {
    // Uniquement les formations liées à au moins une session qui démarre après aujourd'hui
    const today = new Date().toISOString().split('T')[0]
    const sessionsFormula = encodeURIComponent(`IS_AFTER({Date de début de session}, "${today}")`)
    const futureSessions = await atAll(
      `/${TABLES.sessions}?filterByFormula=${sessionsFormula}&fields[]=${encodeURIComponent("Numéro d'action DPC")}`
    )
    const avecSessions = new Set<string>(
      futureSessions.flatMap((r: any) => r.fields["Numéro d'action DPC"] || [])
    )
    records = allFormationRecords.filter((r: any) => avecSessions.has(r.id))
  }

  return records.map((r: any) => ({
    id: r.id,
    nom: r.fields['Nom de la formation'] || '',
    numero: String(r.fields["Numéro d'action DPC"] || ''),
    format: r.fields['Format'] || '',
    public: r.fields['Public concerné'] || [],
    statut: 'Active',
  }))
}

export async function getSessionsByFormation(formationRecordId: string, formationFormat: string = ''): Promise<Session[]> {
  // Toute la table Sessions (en cache), filtrée ici : dans une formule Airtable, ARRAYJOIN d'un
  // champ lié renvoie le champ principal (pas l'ID du record), FIND("recXXX", …) ne trouve rien.
  const allRecords = await allSessionsCached()

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return allRecords
    .filter((r: any) => {
      // The linked field returns an array of record IDs in the API response
      const linkedFormations: string[] = r.fields["Numéro d'action DPC"] || []
      if (!linkedFormations.includes(formationRecordId)) return false

      // Exclure les sessions sans webflow_id (doublons)
      if (!r.fields['webflow_id']) return false

      // Filter future sessions only (skip if no date)
      const dateDebut = r.fields['Date de début de session']
      const dateFin = r.fields['Date de fin de session']
      const isElearning = formationFormat.toLowerCase().includes('e-learning')

      if (!dateDebut) return true

      if (isElearning) {
      // E-learning : inclure les sessions en cours (commencées mais pas encore terminées)
      // Exclure uniquement si la date de fin est dépassée
      if (dateFin && new Date(dateFin) < today) return false
      return true
      }

      // Autres formats : uniquement les sessions futures
      return new Date(dateDebut) >= today
      
    })
    .map((r: any) => ({
      id: r.id,
      session_id: r.fields['session_id'] || '',
      numero: r.fields['Numéro de session'] || '',
      date_debut: r.fields['Date de début de session'] || '',
      date_fin: r.fields['Date de fin de session'] || '',
      date_cv1: r.fields["Date 1ère soirée CV / Date Présentiel"] || '',
      date_cv2: r.fields['Date 2ème soirée CV'] || '',
      date_limite: r.fields["Date limite d'inscription"] || '',
      temps_lisible: r.fields['Temps lisible (Webflow)'] || '',
      formation_id: formationRecordId,
    }))
}

export async function getFormationsDejaFaites(rpps: string, email: string): Promise<string[]> {
  // Returns formation record IDs already completed by this PS
  // Non bloquant pour l'upsell : en cas d'erreur, on n'exclut rien.
  try {
    return await fetchFormationsDejaFaites(rpps, email)
  } catch (e) {
    console.error('[UPSELL] Erreur dans getFormationsDejaFaites:', e)
    return []
  }
}

// Version qui lève les erreurs Airtable (utilisée telle quelle par le cron).
async function fetchFormationsDejaFaites(
  rpps: string,
  email: string,
  opts: { fresh?: boolean } = {}
): Promise<string[]> {
  if (!rpps && !email) {
    return []
  }

  let rppsValue = rpps

  // Pas de RPPS sur le contact HubSpot → on le retrouve via la table Clients
  if (!rppsValue && email) {
    const formula = encodeURIComponent(`{email}="${formulaString(email)}"`)
    const data = await at(`/${TABLES.clients}?filterByFormula=${formula}&fields[]=RPPS&maxRecords=1`, opts)
    if (data.records?.length) {
      rppsValue = data.records[0].fields['RPPS'] || ''
    }
  }

  if (!rppsValue) {
    return []
  }

  const inscFormula = encodeURIComponent(`FIND("${formulaString(String(rppsValue))}", ARRAYJOIN({RPPS}, ","))`)
  const inscriptions = await atAll(
    `/${TABLES.inscriptions}?filterByFormula=${inscFormula}&fields[]=${encodeURIComponent('session_id')}`
  )

  if (!inscriptions.length) {
    return []
  }

  const sessionIds: string[] = inscriptions
    .flatMap((r: any) => r.fields['session_id'] || [])
    .filter(Boolean)

  if (!sessionIds.length) {
    return []
  }

  // Correspondance session → formation : le cron (fresh) relit Airtable, la génération utilise le cache
  const allSessions = opts.fresh
    ? await atAll(`/${TABLES.sessions}?fields[]=${encodeURIComponent('session_id')}&fields[]=${encodeURIComponent("Numéro d'action DPC")}`)
    : await allSessionsCached()

  const matchingSessions = allSessions.filter((r: any) => {
    const sid = r.fields['session_id']
    return sid && sessionIds.includes(sid)
  })

  // Dans la table Sessions, "Numéro d'action DPC" est un champ lié → IDs de records formation
  const formationIds: string[] = matchingSessions
    .flatMap((r: any) => r.fields["Numéro d'action DPC"] || [])
    .filter(Boolean)

  return Array.from(new Set(formationIds))
}

// Le PS est-il inscrit à une session de la formation portant ce numéro DPC ?
// Lève une erreur si Airtable ne répond pas correctement (le cron décide quoi faire).
export async function isPsInscritAFormation(
  rpps: string,
  email: string,
  formationNumero: string
): Promise<boolean> {
  if (!formationNumero) return false

  const dejaFaites = await fetchFormationsDejaFaites(rpps, email, { fresh: true })
  if (!dejaFaites.length) return false

  // Numéro DPC → record ID(s) de la formation (la relance ne stocke que le numéro)
  // &"" force la comparaison en texte, que le champ soit de type nombre ou texte
  const formula = encodeURIComponent(`({Numéro d'action DPC}&"")="${formulaString(String(formationNumero))}"`)
  const formations = await atAll(
    `/${TABLES.formations}?filterByFormula=${formula}&fields[]=${encodeURIComponent("Numéro d'action DPC")}`
  )

  return formations.some((f: any) => dejaFaites.includes(f.id))
}

export interface FormationUpsell {
  nom: string
  format: string
  prochaineSession: string // date lisible ex: "12 mai 2025"
  url_webflow?: string
}

export async function getFormationsUpsell(
  formationIdCourante: string,
  publicConcerne: string[],
  dateFinSessionsPS: string, // ISO date "YYYY-MM-DD" — date de fin de la dernière session sélectionnée
  dejaFaites: string[],       // formation record IDs à exclure
  specialitePS: string       // ex: "Médecin généraliste"
): Promise<FormationUpsell[]> {
  if (!publicConcerne.length) return []

  // ── Étape 1 : charger les formations actives du même public ──────────────
  const orConditions = publicConcerne
    .map((p) => `FIND("${p}", ARRAYJOIN({Public concerné}, ","))`)
    .join(',')
  const formulaFormations = encodeURIComponent(
    `AND({Statut de la formation}="Active", OR(${orConditions}))`
  )
  // Paginé (auparavant tronqué silencieusement au-delà de 100 formations)
  const formationsRecords = await atAll(
    `/${TABLES.formations}?filterByFormula=${formulaFormations}` +
    `&fields[]=${encodeURIComponent('Nom de la formation')}` +
    `&fields[]=${encodeURIComponent("Numéro d'action DPC")}` +
    `&fields[]=${encodeURIComponent('Format')}` +
    `&fields[]=${encodeURIComponent('Public concerné')}` +
    `&fields[]=${encodeURIComponent('URL Webflow')}`
  )

  // Map rapide formation_id → metadata
  const formationsMap = new Map<string, { nom: string; format: string; url_webflow: string }>()
  for (const r of formationsRecords) {
    formationsMap.set(r.id, {
      nom: r.fields['Nom de la formation'] || '',
      format: r.fields['Format'] || '',
      url_webflow: r.fields['URL Webflow'] || '',
    })
  }

  // Construire le set des IDs éligibles (actives, même public, pas courante, pas déjà faites)
  const allFormationIds = Array.from(formationsMap.keys())
    const eligibles = new Set(
      allFormationIds.filter((id: string) => {
        if (id === formationIdCourante) return false
        if (dejaFaites.includes(id)) return false
        if (specialitePS) {
          const rec = formationsRecords.find((r: any) => r.id === id)
          const publics: string[] = rec?.fields['Public concerné'] || []
          // On normalise tirets et espaces avant de comparer
          const normalize = (s: string) => s.toLowerCase().replace(/[-\s]+/g, ' ').trim()
          const specialiteNorm = normalize(specialitePS)
          if (!publics.some((p: string) => {
            const pNorm = normalize(p)
            return pNorm.includes(specialiteNorm) || specialiteNorm.includes(pNorm)
          })) return false
        }
        return true
    })
  )

  if (!eligibles.size) return []

  // ── Étape 2 : charger toutes les sessions qui démarrent APRÈS la fin des sessions du PS ──
  // On ne charge que les sessions futures pertinentes — gain de performance vs charger 1063 sessions
  const formulaSessions = encodeURIComponent(
    `IS_AFTER({Date de début de session}, "${dateFinSessionsPS}")`
  )
  const sortParam = `sort[0][field]=${encodeURIComponent('Date de début de session')}&sort[0][direction]=asc`
  const sessionFields = [
    `fields[]=${encodeURIComponent('Date de début de session')}`,
    `fields[]=${encodeURIComponent("Numéro d'action DPC")}`,
  ].join('&')

  const futureSessions = await atAll(
    `/${TABLES.sessions}?filterByFormula=${formulaSessions}&${sessionFields}&${sortParam}`
  )

  // ── Étape 3 : pour chaque formation éligible, trouver la prochaine session disponible ──
  // Map<formationId, prochaine_date_ISO>
  const prochaineSessionMap = new Map<string, string>()

  for (const session of futureSessions) {
    const formationIds: string[] = session.fields["Numéro d'action DPC"] || []
    const dateDebut: string = session.fields['Date de début de session'] || ''
    if (!dateDebut) continue

    for (const fid of formationIds) {
      if (!eligibles.has(fid)) continue
      // Les sessions sont triées ASC → la première date trouvée pour chaque formation est la plus proche
      if (!prochaineSessionMap.has(fid)) {
        prochaineSessionMap.set(fid, dateDebut)
      }
    }
  }

  // ── Étape 4 : trier par proximité et retourner top 3 ──────────────────────
  const candidates = Array.from(prochaineSessionMap.entries())
    .sort((a, b) => new Date(a[1]).getTime() - new Date(b[1]).getTime())
    .slice(0, 3)
    .map(([fid, dateISO]) => {
      const meta = formationsMap.get(fid)!
      const date = new Date(dateISO)
      const prochaineSession = date.toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
      return { nom: meta.nom, format: meta.format, prochaineSession, url_webflow: meta.url_webflow }
    })

  return candidates
}
// Préchauffe le cache des sessions (appelé à l'arrivée sur l'assistant) : le choix d'une
// formation à l'étape 3 n'attend plus le chargement complet de la table.
export async function warmSessionsCache(): Promise<number> {
  return (await allSessionsCached()).length
}
