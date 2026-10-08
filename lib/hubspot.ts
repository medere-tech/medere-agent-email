const HS_BASE = 'https://api.hubapi.com'

async function hs(path: string, options: RequestInit = {}, attempt = 0): Promise<any> {
  const res = await fetch(`${HS_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  // Limite de débit HubSpot (recherche : quelques requêtes par seconde) : jusqu'à 2 nouveaux essais
  if (res.status === 429 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    return hs(path, options, attempt + 1)
  }
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`HubSpot ${res.status}: ${err}`)
  }
  return res.json()
}

export interface HSContact {
  id: string
  firstname: string
  lastname: string
  email: string
  specialite?: string
  rpps?: string
}

// Normalize accents: "Eléonore" → "eleonore", "DUPRÉ" → "dupre"
function normalizeQuery(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .trim()
}

// part : 'first' = première passe seule (la plus pertinente : email, RPPS ou recherche texte),
// affichée tout de suite ; 'rest' = passes complémentaires, ajoutées ensuite ; 'all' = tout.
export type SearchPart = 'all' | 'first' | 'rest'

export async function searchContacts(query: string, part: SearchPart = 'all'): Promise<HSContact[]> {
  if (!query || query.trim().length < 2) return []

  const isEmail = query.includes('@')
  const isNumeric = /^\d+$/.test(query.trim())
  const normalized = normalizeQuery(query)
  const parts = normalized.split(/\s+/).filter(Boolean)

  const allResults: Map<string, any> = new Map()

  // Les passes de recherche partent en parallèle, puis leurs résultats sont fusionnés dans
  // l'ordre des passes (même classement qu'avant).
  // Les erreurs (429, 401, 5xx) ne sont pas avalées : un résultat vide dû à une
  // panne pousserait le commercial à créer un doublon de contact dans HubSpot.
  const passes: object[] = []
  const runSearch = (body: object) => { passes.push(body) }

  const baseProps = ['firstname', 'lastname', 'email', 'jobtitle', 'rpps', 'hs_object_id']

  if (isEmail) {
    // Email search — exact filter
    runSearch({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'CONTAINS_TOKEN', value: query.trim() }] }],
      properties: baseProps,
      limit: 25,
    })
  } else if (isNumeric) {
    // RPPS search
    runSearch({
      filterGroups: [{ filters: [{ propertyName: 'rpps', operator: 'EQ', value: query.trim() }] }],
      properties: baseProps,
      limit: 25,
    })
  } else {
    // Text search: use HubSpot's full-text "query" field — searches all indexed fields
    // including firstname, lastname, email. Handles partial matches and is case-insensitive.
    // We run two passes: one with original input, one normalized (accent-stripped).
    const searches = [query.trim()]
    if (normalized !== query.trim().toLowerCase()) searches.push(normalized)

    for (const q of searches) {
      runSearch({
        query: q,
        properties: baseProps,
        limit: 25,
      })
    }

    // If 2 words typed, try combined firstname+lastname searches (both orders)
    if (parts.length === 2) {
      const [a, b] = parts
      // "dethie faye" → firstname=dethie AND lastname=faye
      runSearch({
        filterGroups: [
          {
            filters: [
              { propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: a },
              { propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: b },
            ],
          },
          // reversed: "faye dethie" case
          {
            filters: [
              { propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: b },
              { propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: a },
            ],
          },
        ],
        properties: baseProps,
        limit: 25,
      })
    }

    // Also search each word part individually via filterGroups (OR across firstname + lastname)
    // This catches cases where full-text doesn't tokenize the same way
    if (parts.length > 0) {
      const filterGroups = parts.flatMap((part) => [
        { filters: [{ propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: part }] },
        { filters: [{ propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: part }] },
      ])
      runSearch({
        filterGroups,
        properties: baseProps,
        limit: 25,
      })
    }
  }

  const selected = part === 'first' ? passes.slice(0, 1) : part === 'rest' ? passes.slice(1) : passes
  const responses = await Promise.all(selected.map((body) => hs('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify(body),
  })))
  for (const res of responses) {
    for (const r of res.results || []) {
      if (!allResults.has(r.id)) allResults.set(r.id, r)
    }
  }

  return Array.from(allResults.values()).map((r: any) => ({
    id: r.id,
    firstname: r.properties.firstname || '',
    lastname: r.properties.lastname || '',
    email: r.properties.email || '',
    specialite: r.properties.jobtitle || r.properties.specialite || '',
    rpps: r.properties.rpps || '',
  }))
}

export interface LogEmailParams {
  contactId: string
  hubspotOwnerId: string
  subject: string
  body: string
  toEmail: string
  fromEmail: string
  fromName: string
  // Administrateur ayant envoyé le mail au nom du commercial (traçabilité)
  sentByName?: string
}

// Corps de la Note « Email envoyé ». Mail envoyé par un administrateur au nom d'un commercial :
// ligne « Envoyé par … pour le compte de … » sous le sujet.
export function buildSentNoteBody(params: LogEmailParams): string {
  const onBehalf = params.sentByName
    ? `<br><b>Envoyé par :</b> ${params.sentByName} pour le compte de ${params.fromName}`
    : ''
  return `📧 <b>Email envoyé à ${params.toEmail}</b><br><br><b>Sujet :</b> ${params.subject}${onBehalf}<br><br>---<br><br>${params.body.replace(/\n/g, '<br>')}`
}

// Crée une Note sur la fiche du contact PS (scope requis : crm.objects.notes.write).
// Ne lève jamais : renvoie success:false en cas d'échec, l'envoi du mail n'est pas bloqué.
// Crée une Note associée à un contact (lève une erreur si HubSpot refuse)
export async function createNote(contactId: string, body: string, ownerId?: string): Promise<string> {
  const note = await hs('/crm/v3/objects/notes', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
        hs_note_body: body,
      },
      associations: [
        {
          to: { id: parseInt(contactId) },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        },
      ],
    }),
  })
  return String(note.id)
}

export async function logEmailActivity(params: LogEmailParams): Promise<{ success: boolean; id?: string; body: string; error?: string }> {
  const noteBody = buildSentNoteBody(params)
  try {
    const id = await createNote(params.contactId, noteBody, params.hubspotOwnerId)
    console.log('[HUBSPOT] Note créée, ID:', id)
    return { success: true, id, body: noteBody }
  } catch (e: any) {
    console.error('[HUBSPOT] Erreur note:', e.message)
    return { success: false, body: noteBody, error: e.message }
  }
}