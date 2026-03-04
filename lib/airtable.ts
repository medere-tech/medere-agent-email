const BASE_ID = process.env.AIRTABLE_BASE_ID!
const TOKEN = process.env.AIRTABLE_TOKEN!

const TABLES = {
  formations: 'tblu6nfUIhTQ1cbgk',
  sessions: 'tblGVEqH7KCo2GlXz',
  clients: 'tbln6mEwZqHPXVylG',
  inscriptions: 'tblTOJHEwCQhibcMM',
  commerciaux: 'tblaDpXcgiNZfcJiO',
}

async function at(path: string) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    next: { revalidate: 60 },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Airtable ${res.status}: ${err}`)
  }
  return res.json()
}

export interface Commercial {
  id: string
  hubspot_id: string
  name: string
  email: string
  slack_user_id: string
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

export async function getCommerciauxActifs(): Promise<Commercial[]> {
  const params = new URLSearchParams({
    filterByFormula: '{Statut}="Actif"',
    'fields[]': 'hubspot_id',
  })
  // fetch all fields
  const url = `/${TABLES.commerciaux}?filterByFormula=${encodeURIComponent('{Statut}="Actif"')}&fields[]=hubspot_id&fields[]=email&fields[]=slack_user_id&fields[]=hubspot_name`
  const data = await at(url)
  return data.records.map((r: any) => ({
    id: r.id,
    hubspot_id: r.fields.hubspot_id || '',
    name: r.fields.hubspot_name || '',
    email: r.fields.email || '',
    slack_user_id: r.fields.slack_user_id || '',
  }))
}

export async function getFormationsActives(): Promise<Formation[]> {
  // Étape 1 : formations actives
  const formula = encodeURIComponent('{Statut de la formation}="Active"')
  const data = await at(
    `/${TABLES.formations}?filterByFormula=${formula}&fields[]=${encodeURIComponent('Nom de la formation')}&fields[]=${encodeURIComponent("Numéro d'action DPC")}&fields[]=${encodeURIComponent('Format')}&fields[]=${encodeURIComponent('Public concerné')}`
  )
  const formations: Formation[] = data.records.map((r: any) => ({
    id: r.id,
    nom: r.fields['Nom de la formation'] || '',
    numero: String(r.fields["Numéro d'action DPC"] || ''),
    format: r.fields['Format'] || '',
    public: r.fields['Public concerné'] || [],
    statut: 'Active',
  }))

  // Étape 2 : sessions futures — on ne charge que les IDs de formation liés
  const today = new Date().toISOString().split('T')[0]
  const sessionsFormula = encodeURIComponent(`IS_AFTER({Date de début de session}, "${today}")`)
  const sessionsData = await at(
    `/${TABLES.sessions}?filterByFormula=${sessionsFormula}&fields[]=${encodeURIComponent("Numéro d'action DPC")}`
  )

  // Collecte les formation IDs qui ont au moins une session future
  const avecSessions = new Set<string>(
    (sessionsData.records || []).flatMap((r: any) => r.fields["Numéro d'action DPC"] || [])
  )

  // Étape 3 : ne retourner que les formations ayant au moins une session future
  return formations.filter((f) => avecSessions.has(f.id))
}

export async function getSessionsByFormation(formationRecordId: string): Promise<Session[]> {
  // Fetch all sessions with pagination, filter client-side
  // Reason: ARRAYJOIN on linked record fields returns primary field values (not record IDs),
  // so FIND("recXXX", ...) never matches in Airtable formulas.
  const fields = [
    encodeURIComponent('session_id'),
    encodeURIComponent('Numéro de session'),
    encodeURIComponent('Date de début de session'),
    encodeURIComponent('Date de fin de session'),
    encodeURIComponent("Date 1ère soirée CV / Date Présentiel"),
    encodeURIComponent('Date 2ème soirée CV'),
    encodeURIComponent("Date limite d'inscription"),
    encodeURIComponent('Temps lisible (Webflow)'),
    encodeURIComponent("Numéro d'action DPC"),
  ].map(f => `fields[]=${f}`).join('&')

  const sort = `sort[0][field]=${encodeURIComponent('Date de début de session')}&sort[0][direction]=asc`

  // Paginate through all records
  const allRecords: any[] = []
  let offset: string | undefined

  do {
    const offsetParam = offset ? `&offset=${offset}` : ''
    const data = await at(`/${TABLES.sessions}?${fields}&${sort}${offsetParam}`)
    allRecords.push(...(data.records || []))
    offset = data.offset
  } while (offset)

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  return allRecords
    .filter((r: any) => {
      // The linked field returns an array of record IDs in the API response
      const linkedFormations: string[] = r.fields["Numéro d'action DPC"] || []
      if (!linkedFormations.includes(formationRecordId)) return false

      // Filter future sessions only (skip if no date)
      const dateDebut = r.fields['Date de début de session']
      if (!dateDebut) return true // include if no date set
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
  console.log('[UPSELL] getFormationsDejaFaites appelé avec RPPS:', rpps || '(vide)', '/ email:', email || '(vide)')

  if (!rpps && !email) {
    console.log('[UPSELL] Ni RPPS ni email → retourne []')
    return []
  }

  try {
    let rppsValue = rpps

    if (!rppsValue && email) {
      console.log('[UPSELL] Pas de RPPS, recherche par email dans Clients...')
      const formula = encodeURIComponent(`{email}="${email}"`)
      const data = await at(`/${TABLES.clients}?filterByFormula=${formula}&fields[]=RPPS&maxRecords=1`)
      if (data.records?.length) {
        rppsValue = data.records[0].fields['RPPS'] || ''
        console.log('[UPSELL] Client trouvé par email, RPPS récupéré:', rppsValue)
      } else {
        console.log('[UPSELL] Aucun client trouvé par email dans Airtable')
      }
    }

    if (!rppsValue) {
      console.log('[UPSELL] Toujours pas de RPPS → retourne []')
      return []
    }

    console.log('[UPSELL] Recherche inscriptions pour RPPS:', rppsValue)
    const inscFormula = encodeURIComponent(`FIND("${rppsValue}", ARRAYJOIN({RPPS}, ","))`)
    const inscData = await at(
      `/${TABLES.inscriptions}?filterByFormula=${inscFormula}&fields[]=${encodeURIComponent('session_id')}`
    )

    const inscriptions = inscData.records || []
    console.log('[UPSELL] Inscriptions trouvées:', inscriptions.length)

    if (!inscriptions.length) {
      console.log('[UPSELL] Aucune inscription → retourne []')
      return []
    }

    const sessionIds: string[] = inscriptions
      .flatMap((r: any) => r.fields['session_id'] || [])
      .filter(Boolean)

    console.log('[UPSELL] session_id extraits des inscriptions:', sessionIds)

    if (!sessionIds.length) {
      console.log('[UPSELL] Aucun session_id → retourne []')
      return []
    }

    console.log('[UPSELL] Chargement de toutes les sessions Airtable...')
    const allSessions: any[] = []
    let offset: string | undefined
    do {
      const offsetParam = offset ? `&offset=${offset}` : ''
      const data = await at(
        `/${TABLES.sessions}?fields[]=${encodeURIComponent('session_id')}&fields[]=${encodeURIComponent("Numéro d'action DPC")}${offsetParam}`
      )
      allSessions.push(...(data.records || []))
      offset = data.offset
    } while (offset)

    console.log('[UPSELL] Total sessions chargées:', allSessions.length)

    const matchingSessions = allSessions.filter((r: any) => {
      const sid = r.fields['session_id']
      return sid && sessionIds.includes(sid)
    })

    console.log('[UPSELL] Sessions matchant les inscriptions:', matchingSessions.length, matchingSessions.map((r: any) => r.fields['session_id']))

    const formationIds: string[] = matchingSessions
      .flatMap((r: any) => r.fields["Numéro d'action DPC"] || [])
      .filter(Boolean)

    const unique = Array.from(new Set(formationIds))
    console.log('[UPSELL] Formation IDs à exclure de l\'upsell:', unique)

    return unique
  } catch (e) {
    console.error('[UPSELL] Erreur dans getFormationsDejaFaites:', e)
    return []
  }
}

export interface FormationUpsell {
  nom: string
  format: string
  prochaineSession: string // date lisible ex: "12 mai 2025"
}

export async function getFormationsUpsell(
  formationIdCourante: string,
  publicConcerne: string[],
  dateFinSessionsPS: string, // ISO date "YYYY-MM-DD" — date de fin de la dernière session sélectionnée
  dejaFaites: string[]       // formation record IDs à exclure
): Promise<FormationUpsell[]> {
  if (!publicConcerne.length) return []

  // ── Étape 1 : charger les formations actives du même public ──────────────
  const orConditions = publicConcerne
    .map((p) => `FIND("${p}", ARRAYJOIN({Public concerné}, ","))`)
    .join(',')
  const formulaFormations = encodeURIComponent(
    `AND({Statut de la formation}="Active", OR(${orConditions}))`
  )
  const formationsData = await at(
    `/${TABLES.formations}?filterByFormula=${formulaFormations}` +
    `&fields[]=${encodeURIComponent('Nom de la formation')}` +
    `&fields[]=${encodeURIComponent("Numéro d'action DPC")}` +
    `&fields[]=${encodeURIComponent('Format')}` +
    `&fields[]=${encodeURIComponent('Public concerné')}`
  )

  // Map rapide formation_id → metadata
  const formationsMap = new Map<string, { nom: string; format: string }>()
  for (const r of formationsData.records || []) {
    formationsMap.set(r.id, {
      nom: r.fields['Nom de la formation'] || '',
      format: r.fields['Format'] || '',
    })
  }

  // Construire le set des IDs éligibles (actives, même public, pas courante, pas déjà faites)
  const allFormationIds = Array.from(formationsMap.keys())
  const eligibles = new Set(
    allFormationIds.filter(
      (id: string) => id !== formationIdCourante && !dejaFaites.includes(id)
    )
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

  const futureSessions: any[] = []
  let offset: string | undefined
  do {
    const offsetParam = offset ? `&offset=${offset}` : ''
    const data = await at(
      `/${TABLES.sessions}?filterByFormula=${formulaSessions}&${sessionFields}&${sortParam}${offsetParam}`
    )
    futureSessions.push(...(data.records || []))
    offset = data.offset
  } while (offset)

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
      return { nom: meta.nom, format: meta.format, prochaineSession }
    })

  return candidates
}

// Kept for backward compatibility — not used in upsell anymore
export async function getFormationsParPublic(publicConcerne: string[]): Promise<Formation[]> {
  if (!publicConcerne.length) return []
  const orConditions = publicConcerne
    .map((p) => `FIND("${p}", ARRAYJOIN({Public concerné}, ","))`)
    .join(',')
  const formula = encodeURIComponent(
    `AND({Statut de la formation}="Active", OR(${orConditions}))`
  )
  const data = await at(
    `/${TABLES.formations}?filterByFormula=${formula}&fields[]=${encodeURIComponent('Nom de la formation')}&fields[]=${encodeURIComponent("Numéro d'action DPC")}&fields[]=${encodeURIComponent('Format')}&fields[]=${encodeURIComponent('Public concerné')}`
  )
  return data.records.map((r: any) => ({
    id: r.id,
    nom: r.fields['Nom de la formation'] || '',
    numero: String(r.fields["Numéro d'action DPC"] || ''),
    format: r.fields['Format'] || '',
    public: r.fields['Public concerné'] || [],
    statut: 'Active',
  }))
}