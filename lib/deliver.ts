import { Resend } from 'resend'
import { logEmailActivity } from '@/lib/hubspot'
import { getKv, kvConfigured } from '@/lib/kv'
import { renderMail } from '@/lib/render-mail'
import { recordSend } from '@/lib/tracking'
import { enqueueNote } from '@/lib/note-queue'

const resend = new Resend(process.env.RESEND_API_KEY!)

// Envoi d'un mail au PS — chaîne commune à l'envoi initial et à la relance :
//   1. Resend (seul appel qui peut faire échouer la requête), HTML + texte brut par renderMail
//   2. suivi KV atomique (NX : un rejeu idempotent renvoie la première réponse)
//   3. copie séparée au commercial (email_id distinct, jamais suivie)
//   4. Note HubSpot (en cas d'échec : file de nouvel essai, alerte si l'échec est définitif)
//   5. réponse mémorisée 24 h pour les rejeux
export interface DeliverParams {
  commercial: { name: string; email: string; hubspot_id: string; slack_user_id: string }
  ps: { id: string; titre: string; nom: string; prenom: string; email: string; rpps?: string }
  formation: { nom: string; numero: string }
  // Sessions proposées dans le mail (envoi initial), enregistrées dans le suivi pour la relance
  sessions?: { ids: string[]; numeros: string[] }
  sujet: string
  corps: string
  idempotencyKey?: string
  sentBy?: { email: string; name: string }
  // Relance : mail d'origine et en-têtes de fil (In-Reply-To / References)
  kind?: 'initial' | 'relance'
  parentId?: string
  headers?: Record<string, string>
}

export interface DeliverResult {
  status: number
  body: Record<string, any>
}

const SEND_FAILED = "Le mail n'a pas pu être envoyé. Réessaie dans quelques instants ; si le problème persiste, préviens Déthié."

export function validIdempotencyKey(key: unknown): string | undefined {
  return typeof key === 'string' && /^[\w-]{8,128}$/.test(key) ? key : undefined
}

export async function deliverMail(p: DeliverParams): Promise<DeliverResult> {
  const { commercial, ps, formation, sujet, corps, sentBy } = p
  const domain = process.env.RESEND_FROM_DOMAIN || 'medere.fr'
  const from = `${commercial.name} – Médéré <reply@${domain}>`
  const idempotencyKey = validIdempotencyKey(p.idempotencyKey)
  const { html, text } = renderMail(corps)

  // 1. Resend
  let resendId: string | undefined
  try {
    // Pas de bcc : la copie du commercial partagerait l'email_id (pixel + liens)
    // et fausserait les ouvertures/clics du PS. Copie envoyée séparément plus bas.
    const { data, error } = await resend.emails.send(
      { from, replyTo: commercial.email, to: [ps.email], subject: sujet, html, text, ...(p.headers ? { headers: p.headers } : {}) },
      idempotencyKey ? { idempotencyKey } : undefined
    )
    if (error) {
      if (error.name === 'invalid_idempotent_request' || error.name === 'concurrent_idempotent_requests') {
        return { status: 409, body: { success: false, error: "Ce mail est déjà en cours d'envoi ou a déjà été envoyé. Vérifie la page Suivi avant de renvoyer." } }
      }
      throw new Error(error.message)
    }
    resendId = data?.id
  } catch (e: any) {
    console.error('Resend error:', e.message)
    return { status: 500, body: { success: false, error: SEND_FAILED } }
  }

  // À partir d'ici le mail est parti : aucune erreur ne doit renvoyer 500,
  // sinon le commercial renverrait un mail déjà reçu par le PS.
  const kvEnabled = !!(resendId && kvConfigured())

  // 2. Suivi KV (création NX, index, compteur du jour, corps, relance J+3 pour un envoi initial)
  let relanceStored = false
  let relanceDate = ''
  if (kvEnabled) {
    try {
      const recorded = await recordSend({ resendId: resendId!, commercial, ps, formation, sessions: p.sessions, sujet, corps, sentBy, kind: p.kind, parentId: p.parentId })
      if (!recorded.created) {
        const previous = await getKv().get<Record<string, any>>(`send_result:${resendId}`)
        if (previous) return { status: 200, body: { ...previous, replay: true } }
        return { status: 409, body: { success: false, error: 'Ce mail a déjà été envoyé (traitement en cours). Vérifie la page Suivi avant de renvoyer.' } }
      }
      relanceStored = p.kind !== 'relance'
      relanceDate = recorded.relanceDate
    } catch (e: any) {
      console.error('[SEND] Tracking KV non enregistré pour', resendId, ':', e.message)
    }
  }

  // 3. Copie au commercial : envoi séparé, jamais enregistré dans le KV (ses ouvertures/clics
  // sont ignorés par le webhook). Non bloquant.
  try {
    const { error } = await resend.emails.send(
      { from, replyTo: commercial.email, to: [commercial.email], subject: sujet, html, text },
      idempotencyKey ? { idempotencyKey: `${idempotencyKey}-copie` } : undefined
    )
    if (error) throw new Error(error.message)
  } catch (e: any) {
    console.error('[SEND] Copie commercial non envoyée:', e.message)
  }

  // 4. Note HubSpot sur la fiche du PS
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
  if (!hubspotResult.success && ps.id) {
    await enqueueNote({
      contactId: ps.id,
      body: hubspotResult.body,
      ownerId: commercial.hubspot_id,
      label: `Email envoyé — « ${sujet} » (${commercial.name})`,
      firstError: hubspotResult.error || 'erreur inconnue',
    })
  }

  const result = {
    success: true,
    resend_id: resendId,
    hubspot_logged: hubspotResult.success,
    relance_stored: relanceStored,
    relance_date: relanceDate,
  }

  // 5. Réponse mémorisée 24 h (durée de validité des clés d'idempotence Resend)
  if (kvEnabled) {
    try {
      await getKv().set(`send_result:${resendId}`, result, { ex: 86400 })
    } catch (e: any) {
      console.error('[SEND] send_result non enregistré:', e.message)
    }
  }
  return { status: 200, body: result }
}
