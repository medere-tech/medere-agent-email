import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { logEmailActivity } from '@/lib/hubspot'

const resend = new Resend(process.env.RESEND_API_KEY!)

interface SendPayload {
  commercial: {
    name: string
    email: string
    hubspot_id: string
    slack_user_id: string
  }
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
    const payload: SendPayload = await req.json()
    const { commercial, ps, formation, sujet, corps } = payload

    if (!ps.email) {
      return NextResponse.json({ error: 'Email du PS manquant' }, { status: 400 })
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
        error: `Erreur envoi email : ${e.message}`,
      }, { status: 500 })
    }

    // À partir d'ici le mail est parti : aucune erreur ne doit renvoyer 500,
    // sinon le commercial renverrait un mail déjà reçu par le PS.
    const kvEnabled = !!(resendId && process.env.KV_REST_API_URL)

    // 1 bis. Tracking KV (hors du try Resend). NX : si la clé existe déjà, c'est un
    // rejeu idempotent du même envoi → on ne recrée ni Note, ni relance, ni copie.
    if (kvEnabled) {
      try {
        const { kv } = await import('@vercel/kv')
        const created = await kv.set(
          `email_track:${resendId}`,
          {
            contact_id: ps.id,
            ps_nom: `${ps.titre} ${ps.prenom} ${ps.nom}`.trim(),
            ps_email: ps.email,
            commercial_name: commercial.name,
            formation_nom: formation.nom,
            sujet,
            statut: 'envoyé',
            sent_at: new Date().toISOString(),
            opened_at: null,
            clicked_at: null,
          },
          { nx: true }
        )

        if (created === null) {
          const previous = await kv.get<Record<string, any>>(`send_result:${resendId}`)
          if (previous) return NextResponse.json({ ...previous, replay: true })
          return NextResponse.json({
            success: false,
            error: 'Ce mail a déjà été envoyé (traitement en cours). Vérifie la page Suivi avant de renvoyer.',
          }, { status: 409 })
        }

        await kv.zadd('emails_index', { score: Date.now(), member: resendId! })
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
    })

    // 3. Stocker pour relance J+3
    const relanceDate = new Date()
    relanceDate.setDate(relanceDate.getDate() + 3)

    let relanceStored = false
    try {
      if (process.env.KV_REST_API_URL) {
        const { kv } = await import('@vercel/kv')
        const key = `relance:${Date.now()}`
        await kv.set(key, {
          commercial_slack_id: commercial.slack_user_id,
          commercial_name: commercial.name,
          ps_nom: `${ps.titre} ${ps.prenom} ${ps.nom}`,
          ps_email: ps.email,
          ps_rpps: ps.rpps || '',
          ps_hubspot_id: ps.id,
          formation_nom: formation.nom,
          formation_numero: formation.numero,
          sujet,
          corps,
          sent_at: new Date().toISOString(),
          relance_at: relanceDate.toISOString().split('T')[0],
        }, { exat: Math.floor(relanceDate.getTime() / 1000) + 86400 * 4 }) // expire J+4
        relanceStored = true
      }
    } catch (e) {
      console.error('KV store error:', e)
    }

    const result = {
      success: true,
      resend_id: resendId,
      hubspot_logged: hubspotResult.success,
      relance_stored: relanceStored,
      relance_date: relanceDate.toISOString().split('T')[0],
    }

    // Mémorise la réponse 24 h (durée de validité des clés d'idempotence Resend)
    // pour la renvoyer telle quelle en cas de rejeu.
    if (kvEnabled) {
      try {
        const { kv } = await import('@vercel/kv')
        await kv.set(`send_result:${resendId}`, result, { ex: 86400 })
      } catch (e: any) {
        console.error('[SEND] send_result non enregistré:', e.message)
      }
    }

    return NextResponse.json(result)
  } catch (e: any) {
    console.error('Send error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
