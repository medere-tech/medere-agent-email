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

export async function searchContacts(query: string): Promise<HSContact[]> {
  // Search by email OR name
  const isEmail = query.includes('@')
  const isNumeric = /^\d+$/.test(query)

  const filters = isEmail
    ? [{ propertyName: 'email', operator: 'CONTAINS_TOKEN', value: query }]
    : isNumeric
    ? [{ propertyName: 'hs_additional_emails', operator: 'CONTAINS_TOKEN', value: query }]
    : [
        {
          propertyName: 'lastname',
          operator: 'CONTAINS_TOKEN',
          value: query.split(' ')[0],
        },
      ]

  const body = {
    filterGroups: [{ filters }],
    properties: ['firstname', 'lastname', 'email', 'specialite', 'jobtitle', 'hs_object_id'],
    limit: 10,
  }

  // Also try a fulltext search approach
  const res = await hs('/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: JSON.stringify(body),
  })

  return (res.results || []).map((r: any) => ({
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
  const WRITE_SCOPE_AVAILABLE = process.env.HS_WRITE_SCOPE_ENABLED === 'true'

  if (!WRITE_SCOPE_AVAILABLE) {
    return { success: false, disabled: true }
  }

  try {
    const emailObj = await hs('/crm/v3/objects/emails', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          hs_timestamp: new Date().toISOString(),
          hubspot_owner_id: params.hubspotOwnerId,
          hs_email_direction: 'EMAIL',
          hs_email_status: 'SENT',
          hs_email_subject: params.subject,
          hs_email_text: params.body,
          hs_email_to_email: params.toEmail,
          hs_email_from_email: params.fromEmail,
          hs_email_from_firstname: params.fromName,
        },
      }),
    })

    // Associate with contact
    await hs(
      `/crm/v4/objects/emails/${emailObj.id}/associations/contacts/${params.contactId}/email_to_contact`,
      { method: 'PUT', body: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 198 }]) }
    )

    return { success: true, id: emailObj.id }
  } catch (e: any) {
    console.error('HubSpot log error:', e.message)
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
