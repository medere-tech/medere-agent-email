import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { getKv } from '@/lib/kv'
import { applyEvent, type TrackingEvent } from '@/lib/tracking'

const resend = new Resend(process.env.RESEND_API_KEY!)

const DEDUP_TTL = 60 * 60 * 24 * 7 // Resend rejoue un webhook pendant quelques jours au maximum

// Événements Resend traités → fait enregistré sur l'envoi (voir EVENT_SCRIPT dans lib/kv-schema.ts)
const EVENTS: Record<string, TrackingEvent> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
}

export async function POST(req: NextRequest) {
  // 1. Vérification de signature : seul cas qui renvoie une erreur à Resend
  let event: ReturnType<typeof resend.webhooks.verify>
  const svixId = req.headers.get('svix-id') ?? ''
  try {
    // CRITIQUE : utiliser le body brut pour la vérification de signature
    const payload = await req.text()

    event = resend.webhooks.verify({
        payload,
        headers: {
            id: svixId,
            timestamp: req.headers.get('svix-timestamp') ?? '',
            signature: req.headers.get('svix-signature') ?? '',
        },
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
    })
  } catch (e: any) {
    console.error('[WEBHOOK] Signature invalide:', e.message)
    return NextResponse.json({ error: 'Invalid webhook' }, { status: 400 })
  }

  // 2. Signature valide → toujours 2xx. Une erreur de traitement est journalisée
  // mais ne provoque pas de rejeu (les rejeux créaient des Notes HubSpot en double).
  try {
    await handleEvent(event, svixId)
  } catch (e: any) {
    console.error('[WEBHOOK] Erreur de traitement:', e.message)
  }
  return NextResponse.json({ received: true })
}

async function handleEvent(event: ReturnType<typeof resend.webhooks.verify>, svixId: string) {
  const data = event.data as any
  console.log('[WEBHOOK] Event reçu:', event.type, data?.email_id)

  const kind = EVENTS[event.type]
  if (!kind) return

  const emailId = data?.email_id
  if (!emailId) return

  const kv = getKv()

  // Dédoublonnage : un même événement (même svix-id) n'est traité qu'une fois
  if (svixId) {
    const first = await kv.set(`webhook_event:${svixId}`, 1, { nx: true, ex: DEDUP_TTL })
    if (first === null) {
      console.log('[WEBHOOK] Événement déjà traité, ignoré:', svixId)
      return
    }
  }

  // Date de l'événement chez Resend (et non de réception) : un rejeu tardif ne fausse
  // ni la détection des événements automatiques ni les dates affichées.
  const createdAt = new Date((event as any).created_at || '')
  const eventAt = Number.isFinite(createdAt.getTime()) ? createdAt : new Date()

  const result = await applyEvent(emailId, kind, eventAt, typeof data?.message_id === 'string' ? data.message_id : '')

  if (!result.tracked) {
    // Inclut les copies envoyées au commercial (jamais enregistrées dans le KV)
    console.log('[WEBHOOK] email_id non trouvé dans KV:', emailId)
    return
  }
  console.log('[WEBHOOK] Statut KV mis à jour:', emailId, kind, result.automatic ? '(automatique)' : '', '→', result.statut)

  // Une seule Note HubSpot par type (première ouverture, premier clic), jamais pour
  // un événement automatique ; le verrou est posé atomiquement par le script.
  const noteKind = result.createOpenNote ? 'opened' : result.createClickNote ? 'clicked' : null
  if (!noteKind || !result.entry) return

  const entry = result.entry
  const emoji = noteKind === 'opened' ? '👁️' : '🖱️'
  const action = noteKind === 'opened' ? 'ouvert' : 'cliqué'
  const date = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
  }).format(eventAt)

  try {
    await logNoteHubSpot(
      entry.contact_id,
      `${emoji} <b>Email ${action} le ${date}</b><br><br><b>Sujet :</b> ${entry.sujet}<br><b>Commercial :</b> ${entry.commercial_name}`
    )
    console.log('[WEBHOOK] Note HubSpot créée pour contact:', entry.contact_id)
  } catch (e) {
    // Libère le verrou : le prochain événement du même type pourra recréer la Note
    await kv.del(`hubspot_note:${emailId}:${noteKind}`)
    throw e
  }
}

async function logNoteHubSpot(contactId: string, body: string) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: body,
      },
      associations: [{
        to: { id: parseInt(contactId) },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
      }],
    }),
  })
  if (!res.ok) throw new Error(`HubSpot note error: ${await res.text()}`)
}
