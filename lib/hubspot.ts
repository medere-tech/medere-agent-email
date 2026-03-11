const HS_TOKEN = process.env.HUBSPOT_TOKEN!
const HS_BASE = 'https://api.hubapi.com'

async function hs(path: string, options: RequestInit = {}) {
  const res = await fetch(`${HS_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
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

export async function searchContacts(query: string): Promise<HSContact[]> {
  if (!query || query.trim().length < 2) return []

  const isEmail = query.includes('@')
  const isNumeric = /^\d+$/.test(query.trim())
  const normalized = normalizeQuery(query)
  const parts = normalized.split(/\s+/).filter(Boolean)

  const allResults: Map<string, any> = new Map()

  // Helper to run one search and merge results
  const runSearch = async (body: object) => {
    try {
      const res = await hs('/crm/v3/objects/contacts/search', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      for (const r of res.results || []) {
        if (!allResults.has(r.id)) allResults.set(r.id, r)
      }
    } catch { /* ignore partial failures */ }
  }

  const baseProps = ['firstname', 'lastname', 'email', 'jobtitle', 'rpps', 'hs_object_id']

  if (isEmail) {
    // Email search — exact filter
    await runSearch({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'CONTAINS_TOKEN', value: query.trim() }] }],
      properties: baseProps,
      limit: 25,
    })
  } else if (isNumeric) {
    // RPPS search
    await runSearch({
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
      await runSearch({
        query: q,
        properties: baseProps,
        limit: 25,
      })
    }

    // If 2 words typed, try combined firstname+lastname searches (both orders)
    if (parts.length === 2) {
      const [a, b] = parts
      // "dethie faye" → firstname=dethie AND lastname=faye
      await runSearch({
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
      await runSearch({
        filterGroups,
        properties: baseProps,
        limit: 25,
      })
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

export async function searchContactsByName(nom: string, prenom?: string): Promise<HSContact[]> {
  const filterGroups: any[] = []

  if (prenom) {
    filterGroups.push({
      filters: [
        { propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: nom },
        { propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: prenom },
      ],
    })
  }

  filterGroups.push({
    filters: [{ propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: nom }],
  })

  const body = {
    filterGroups,
    properties: ['firstname', 'lastname', 'email', 'jobtitle', 'hs_object_id'],
    limit: 10,
  }

  const res = await hs('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  return (res.results || []).map((r: any) => ({
    id: r.id,
    firstname: r.properties.firstname || '',
    lastname: r.properties.lastname || '',
    email: r.properties.email || '',
    specialite: r.properties.jobtitle || '',
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
}

// Requires crm.objects.contacts.write scope
// Gracefully handles missing scope
export async function logEmailActivity(params: LogEmailParams): Promise<{ success: boolean; id?: string; disabled?: boolean }> {
  try {
    const noteBody = `📧 <b>Email envoyé à ${params.toEmail}</b><br><br><b>Sujet :</b> ${params.subject}<br><br>---<br><br>${params.body.replace(/\n/g, '<br>')}`

    const note = await hs('/crm/v3/objects/notes', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date().toISOString(),
          hubspot_owner_id: params.hubspotOwnerId,
          hs_note_body: noteBody,
        },
        associations: [
          {
            to: { id: parseInt(params.contactId) },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
          },
        ],
      }),
    })

    console.log('[HUBSPOT] Note créée, ID:', note.id)
    return { success: true, id: note.id }
  } catch (e: any) {
    console.error('[HUBSPOT] Erreur note:', e.message)
    return { success: false }
  }
}

export async function getOwners(): Promise<{ id: string; email: string; firstName: string; lastName: string }[]> {
  const res = await hs('/crm/v3/owners?limit=100')
  return (res.results || []).map((o: any) => ({
    id: o.id,
    email: o.email,
    firstName: o.firstName,
    lastName: o.lastName,
  }))
}