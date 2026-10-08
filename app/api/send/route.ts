import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { logEmailActivity } from '@/lib/hubspot'
import { getKv, kvConfigured } from '@/lib/kv'
import { recordSend } from '@/lib/tracking'
import { requireActor, senderFor } from '@/lib/identity'
import { checkRateLimit, rateLimitMessage } from '@/lib/ratelimit'

const resend = new Resend(process.env.RESEND_API_KEY!)

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
    const commercial = { name: sender.name, email: sender.email, hubspot_id: sender.hubspot_id, slack_user_id: sender.slack_user_id }
    // Administrateur agissant au nom d'un autre commercial : tracé dans le suivi et la Note HubSpot
    const sentBy = resolved.onBehalf ? { email: actor.email, name: actor.name } : undefined

    const limit = await checkRateLimit('send', actor.email)
    if (!limit.ok) return NextResponse.json({ error: rateLimitMessage('send', limit.retryAfterSeconds) }, { status: 429 })

    if (!ps?.email) {
      return NextResponse.json({ error: "Ce contact n'a pas d'adresse email dans HubSpot." }, { status: 400 })
    }

    const domain = process.env.RESEND_FROM_DOMAIN || 'medere.fr'
    const fromName = commercial.name

    // Clé d'idempotence générée côté client à l'étape 5 : un double clic ou un
    // renvoi après timeout renvoie le même email_id au lieu d'un second mail.
    const idempotencyKey =
      typeof payload.idempotencyKey === 'string' && /^[\w-]{8,128}$/.test(payload.idempotencyKey)
        ? payload.idempotencyKey
        : undefined

    // 1. Envoyer l'email via Resend — seul cet appel peut faire échouer la requête
    let resendId: string | undefined

    const html = corps
      .replace(/\n/g, '<br>')
      // Convertir les liens Markdown [texte](url) en balises ahrefs <a>
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2">$1</a>')
      // Convertir les URLs brutes restantes en balises <a>
      .replace(/(^|[\s<br>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>')
      // Convertir les URLs brutes commençant par www.
      .replace(/(^|[\s<br>])(www\.[^\s<]+)/g, '$1<a href="https://$2">$2</a>')

    try {
      // Pas de bcc : la copie du commercial partagerait l'email_id (pixel + liens)
      // et fausserait les ouvertures/clics du PS. Copie envoyée séparément plus bas.
      const { data, error } = await resend.emails.send(
        {
          from: `${fromName} – Médéré <reply@${domain}>`,
          replyTo: commercial.email,
          to: [ps.email],
          subject: sujet,
          html,
        },
        idempotencyKey ? { idempotencyKey } : undefined
      )

      if (error) {
        if (error.name === 'invalid_idempotent_request' || error.name === 'concurrent_idempotent_requests') {
          return NextResponse.json({
            success: false,
            error: "Ce mail est déjà en cours d'envoi ou a déjà été envoyé. Vérifie la page Suivi avant de renvoyer.",
          }, { status: 409 })
        }
        throw new Error(error.message)
      }
      resendId = data?.id
    } catch (e: any) {
      console.error('Resend error:', e.message)
      return NextResponse.json({
        success: false,
        error: "Le mail n'a pas pu être envoyé. Réessaie dans quelques instants ; si le problème persiste, préviens Déthié.",
      }, { status: 500 })
    }

    // À partir d'ici le mail est parti : aucune erreur ne doit renvoyer 500,
    // sinon le commercial renverrait un mail déjà reçu par le PS.
    const kvEnabled = !!(resendId && kvConfigured())

    // 1 bis. Tracking KV (hors du try Resend), en une écriture atomique : email_track (NX),
    // index, compteur du jour, corps et relance J+3. Si l'envoi existe déjà, c'est un
    // rejeu idempotent du même envoi → on ne recrée ni Note, ni relance, ni copie.
    let relanceStored = false
    let relanceDate = ''
    if (kvEnabled) {
      try {
        const recorded = await recordSend({ resendId: resendId!, commercial, ps, formation, sujet, corps, sentBy })
        if (!recorded.created) {
          const previous = await getKv().get<Record<string, any>>(`send_result:${resendId}`)
          if (previous) return NextResponse.json({ ...previous, replay: true })
          return NextResponse.json({
            success: false,
            error: 'Ce mail a déjà été envoyé (traitement en cours). Vérifie la page Suivi avant de renvoyer.',
          }, { status: 409 })
        }
        relanceStored = true
        relanceDate = recorded.relanceDate
      } catch (e: any) {
        console.error('[SEND] Tracking KV non enregistré pour', resendId, ':', e.message)
      }
    }

    // 1 ter. Copie au commercial : envoi séparé (email_id distinct), jamais enregistré
    // dans le KV → ses ouvertures/clics sont ignorés par le webhook. Non bloquant.
    try {
      const { error } = await resend.emails.send(
        {
          from: `${fromName} – Médéré <reply@${domain}>`,
          replyTo: commercial.email,
          to: [commercial.email],
          subject: sujet,
          html,
        },
        idempotencyKey ? { idempotencyKey: `${idempotencyKey}-copie` } : undefined
      )
      if (error) throw new Error(error.message)
    } catch (e: any) {
      console.error('[SEND] Copie commercial non envoyée:', e.message)
    }

    // 2. Logger dans HubSpot (si scope disponible)
    const hubspotResult = await logEmailActivity({
      contactId: ps.id,
      hubspotOwnerId: commercial.hubspot_id,
      subject: sujet,
      body: corps,
      toEmail: ps.email,
      fromEmail: commercial.email,
      fromName: commercial.name,
      sentByName: sentBy?.name,
    })

    // 3. La relance J+3 est planifiée par recordSend (relances_due, lue par le cron)
    const result = {
      success: true,
      resend_id: resendId,
      hubspot_logged: hubspotResult.success,
      relance_stored: relanceStored,
      relance_date: relanceDate,
    }

    // Mémorise la réponse 24 h (durée de validité des clés d'idempotence Resend)
    // pour la renvoyer telle quelle en cas de rejeu.
    if (kvEnabled) {
      try {
        await getKv().set(`send_result:${resendId}`, result, { ex: 86400 })
      } catch (e: any) {
        console.error('[SEND] send_result non enregistré:', e.message)
      }
    }

    return NextResponse.json(result)
  } catch (e: any) {
    console.error('Send error:', e)
    return NextResponse.json({ error: "Le mail n'a pas pu être envoyé. Réessaie dans quelques instants ; si le problème persiste, préviens Déthié." }, { status: 500 })
  }
}
