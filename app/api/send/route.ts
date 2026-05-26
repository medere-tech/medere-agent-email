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
    const fromEmail = `${commercial.name.toLowerCase().split(' ')[0]}@${domain}`

    // 1. Envoyer l'email via Resend
    let emailSent = false
    let resendId: string | undefined

    try {
      const { data, error } = await resend.emails.send({
        from: `${fromName} – Médéré <reply@${domain}>`,
        replyTo: commercial.email,
        to: [ps.email],
        subject: sujet,
        html: corps
          .replace(/\n/g, '<br>')
          // Convertir les liens Markdown [texte](url) en balises ahrefs <a>
          .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2">$1</a>')
          // Convertir les URLs brutes restantes en balises <a>
          .replace(/(^|[\s<br>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>'),
        bcc: [commercial.email],
      })

      if (error) throw new Error(error.message)
      emailSent = true
      resendId = data?.id

      // Ajouter juste après :
    if (resendId && process.env.KV_REST_API_URL) {
      const { kv } = await import('@vercel/kv')
      await kv.set(
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
      )
      await kv.zadd('emails_index', { score: Date.now(), member: resendId })
    }
    } catch (e: any) {
      console.error('Resend error:', e.message)
      // Continue — log HubSpot even if send fails, surface the error
      return NextResponse.json({
        success: false,
        error: `Erreur envoi email : ${e.message}`,
      }, { status: 500 })
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

    return NextResponse.json({
      success: true,
      resend_id: resendId,
      hubspot_logged: hubspotResult.success,
      hubspot_disabled: hubspotResult.disabled,
      relance_stored: relanceStored,
      relance_date: relanceDate.toISOString().split('T')[0],
    })
  } catch (e: any) {
    console.error('Send error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
