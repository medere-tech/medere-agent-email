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
  const formula = encodeURIComponent('{Statut de la formation}="Active"')
  const fields = [
    'fields[]=Nom+de+la+formation',
    `fields[]=${encodeURIComponent("Numéro d'action DPC")}`,
    'fields[]=Format',
    `fields[]=${encodeURIComponent('Public concerné')}`,
    `fields[]=${encodeURIComponent('Statut de la formation')}`,
  ].join('&')
  const data = await at(
    `/${TABLES.formations}?filterByFormula=${formula}&fields[]=${encodeURIComponent('Nom de la formation')}&fields[]=${encodeURIComponent("Numéro d'action DPC")}&fields[]=${encodeURIComponent('Format')}&fields[]=${encodeURIComponent('Public concerné')}`
  )
  return data.records.map((r: any) => ({
    id: r.id,
    nom: r.fields['Nom de la formation'] || '',
    numero: String(r.fields["Numéro d'action DPC"] || ''),
    format: r.fields['Format'] || '',
    public: r.fields['Public concerné'] || [],
    statut: r.fields['Statut de la formation'] || '',
  }))
}

export async function getSessionsByFormation(formationRecordId: string): Promise<Session[]> {
  // Filter sessions where linked Numéro d'action DPC contains this record ID
  const formula = encodeURIComponent(
    `AND(FIND("${formationRecordId}", ARRAYJOIN({Numéro d'action DPC}, ",")), IS_AFTER({Date de début de session}, TODAY()))`
  )
  const data = await at(
    `/${TABLES.sessions}?filterByFormula=${formula}&fields[]=${encodeURIComponent('session_id')}&fields[]=${encodeURIComponent('Numéro de session')}&fields[]=${encodeURIComponent('Date de début de session')}&fields[]=${encodeURIComponent('Date de fin de session')}&fields[]=${encodeURIComponent('Date 1ère soirée CV / Date Présentiel')}&fields[]=${encodeURIComponent('Date 2ème soirée CV')}&fields[]=${encodeURIComponent('Date limite d\'inscription')}&fields[]=${encodeURIComponent('Temps lisible (Webflow)')}&fields[]=${encodeURIComponent("Numéro d'action DPC")}&sort[0][field]=${encodeURIComponent('Date de début de session')}&sort[0][direction]=asc`
  )
  return data.records.map((r: any) => ({
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

export async function getFormationsParPublic(publicConcerne: string[]): Promise<Formation[]> {
  if (!publicConcerne.length) return []
  // Get formations with overlapping public concerné
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
