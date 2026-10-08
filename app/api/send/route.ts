import { NextRequest, NextResponse } from 'next/server'
import { requireActor, senderFor } from '@/lib/identity'
import { checkRateLimit, rateLimitMessage } from '@/lib/ratelimit'
import { deliverMail } from '@/lib/deliver'

interface SendPayload {
  // Fiche Airtable du commercial choisi à l'étape 1 : seul un administrateur peut en désigner
  // une autre que la sienne. Nom, email, HubSpot et Slack sont relus côté serveur.
  commercial_id?: string
  ps: {
    id: string          // HubSpot contact ID
    titre: string
    nom: string
    prenom: string
    email: string
    rpps?: string
  }
  formation: {
    nom: string
    numero: string
  }
  sujet: string
  corps: string
  // Clé d'idempotence générée côté client à l'étape 5 : un double clic ou un
  // renvoi après timeout renvoie le même email_id au lieu d'un second mail.
  idempotencyKey?: string
}

export async function POST(req: NextRequest) {
  try {
    // Identité relue côté serveur : aucun commercial venant du navigateur n'est cru
    const guard = await requireActor()
    if (!guard.ok) return guard.response
    const { actor } = guard

    const payload: SendPayload = await req.json()
    const { ps, formation, sujet, corps } = payload

    const resolved = senderFor(actor, payload.commercial_id)
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    const sender = resolved.sender

    const limit = await checkRateLimit('send', actor.email)
    if (!limit.ok) return NextResponse.json({ error: rateLimitMessage('send', limit.retryAfterSeconds) }, { status: 429 })

    if (!ps?.email) {
      return NextResponse.json({ error: "Ce contact n'a pas d'adresse email dans HubSpot." }, { status: 400 })
    }

    const { status, body } = await deliverMail({
      commercial: { name: sender.name, email: sender.email, hubspot_id: sender.hubspot_id, slack_user_id: sender.slack_user_id },
      ps,
      formation,
      sujet,
      corps,
      idempotencyKey: payload.idempotencyKey,
      // Administrateur agissant au nom d'un autre commercial : tracé dans le suivi et la Note HubSpot
      sentBy: resolved.onBehalf ? { email: actor.email, name: actor.name } : undefined,
    })
    return NextResponse.json(body, { status })
  } catch (e: any) {
    console.error('Send error:', e)
    return NextResponse.json({ error: "Le mail n'a pas pu être envoyé. Réessaie dans quelques instants ; si le problème persiste, préviens Déthié." }, { status: 500 })
  }
}
