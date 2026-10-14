import { NextRequest, NextResponse } from 'next/server'
import { requireActor, senderFor } from '@/lib/identity'
import { checkRateLimit, rateLimitMessage } from '@/lib/ratelimit'
import { deliverMail } from '@/lib/deliver'
import { getFormationAndSessions } from '@/lib/airtable'

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
    id?: string         // record Airtable de la formation
    nom: string
    numero: string
  }
  // Sessions choisies à l'étape 3 (records Airtable), enregistrées dans le suivi pour la relance
  session_ids?: string[]
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
      formation: { nom: formation.nom, numero: formation.numero },
      sessions: await sessionsEnvoyees(formation, payload.session_ids),
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

// Sessions du mail, relues côté serveur (cache Airtable) : seules les sessions liées à la formation
// envoyée sont retenues. Jamais bloquant : sans sessions retrouvées, la relance les cherchera dans
// le texte du mail (lib/relance).
async function sessionsEnvoyees(formation: SendPayload['formation'], ids: unknown): Promise<{ ids: string[]; numeros: string[] } | undefined> {
  const sessionIds = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string').slice(0, 20) : []
  if (!formation?.id || !sessionIds.length) return undefined
  try {
    const selection = await getFormationAndSessions(formation.id, sessionIds)
    if (!selection || String(selection.formation.numero).trim() !== String(formation.numero || '').trim() || !selection.sessions.length) return undefined
    return { ids: selection.sessions.map((s) => s.id), numeros: selection.sessions.map((s) => String(s.numero)) }
  } catch (e: any) {
    console.error('[SEND] Sessions du mail non enregistrées :', e.message)
    return undefined
  }
}
