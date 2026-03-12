import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { logEmailActivity } from '@/lib/hubspot'

const resend = new Resend(process.env.RESEND_API_KEY!)

export async function POST(req: NextRequest) {
  try {
    // CRITIQUE : utiliser le body brut pour la vérification de signature
    const payload = await req.text()

    const event = resend.webhooks.verify({
        payload,
        headers: {
            id: req.headers.get('svix-id') ?? '',
            timestamp: req.headers.get('svix-timestamp') ?? '',
            signature: req.headers.get('svix-signature') ?? '',
        },
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
    })

    console.log('[WEBHOOK] Event reçu:', event.type, event.data?.email_id)

    // Uniquement email.opened et email.clicked
    if (event.type !== 'email.opened' && event.type !== 'email.clicked') {
      return NextResponse.json({ received: true })
    }

    const emailId = event.data?.email_id
    if (!emailId) return NextResponse.json({ received: true })

    // Retrouver le contact via le KV
    const { kv } = await import('@vercel/kv')
    const tracked = await kv.get<{ contact_id: string; commercial_name: string; sujet: string }>(
      `email_track:${emailId}`
    )

    if (!tracked) {
      console.log('[WEBHOOK] email_id non trouvé dans KV:', emailId)
      return NextResponse.json({ received: true })
    }

    // Créer une Note HubSpot
    const emoji = event.type === 'email.opened' ? '👁️' : '🖱️'
    const action = event.type === 'email.opened' ? 'ouvert' : 'cliqué'
    const date = new Intl.DateTimeFormat('fr-FR', {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
    }).format(new Date())

    await logNoteHubSpot(
      tracked.contact_id,
      `${emoji} <b>Email ${action} le ${date}</b><br><br><b>Sujet :</b> ${tracked.sujet}<br><b>Commercial :</b> ${tracked.commercial_name}`
    )

    console.log('[WEBHOOK] Note HubSpot créée pour contact:', tracked.contact_id)
    return NextResponse.json({ received: true })

  } catch (e: any) {
    console.error('[WEBHOOK] Erreur:', e.message)
    return NextResponse.json({ error: 'Invalid webhook' }, { status: 400 })
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