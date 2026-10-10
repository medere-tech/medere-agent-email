import { NextRequest, NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { checkRateLimit, rateLimitMessage } from '@/lib/ratelimit'
import { checkRelance, originalMessageId } from '@/lib/relance'
import { deliverMail, validIdempotencyKey } from '@/lib/deliver'
import { attachRelance } from '@/lib/tracking'
import { getKv } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'

// Envoi de la relance : envoi complet (suivi, copie, Note HubSpot), dans le fil du mail d'origine
// (In-Reply-To / References), rattaché au mail d'origine, une seule fois par mail.
export async function POST(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response
  const { actor } = guard
  try {
    const payload = await req.json()
    const id = String(payload.id || '')
    const sujet = String(payload.sujet || '').trim()
    const corps = String(payload.corps || '').trim()
    const key = validIdempotencyKey(payload.idempotencyKey)
    if (!sujet || !corps) return NextResponse.json({ error: "L'objet et le texte de la relance sont obligatoires." }, { status: 400 })
    if (!key) return NextResponse.json({ error: 'Une erreur est survenue. Recharge la page et réessaie.' }, { status: 400 })

    const kv = getKv()
    const lockKey = KEYS.relanceLock(id)

    // Rejeu de la même requête (double clic, délai réseau) après un envoi réussi : même réponse
    const lockValue = await kv.get<string>(lockKey)
    if (lockValue === key) {
      const entry = await kv.get<Record<string, any>>(KEYS.track(id))
      if (entry?.relance_id) {
        const previous = await kv.get<Record<string, any>>(KEYS.sendResult(entry.relance_id))
        if (previous) return NextResponse.json({ ...previous, replay: true })
      }
    }

    const check = await checkRelance(actor, id)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })

    const limit = await checkRateLimit('send', actor.email)
    if (!limit.ok) return NextResponse.json({ error: rateLimitMessage('send', limit.retryAfterSeconds) }, { status: 429 })

    // Une seule relance à la fois pour ce mail (la même clé d'idempotence peut reprendre l'envoi)
    const locked = await kv.set(lockKey, key, { nx: true, ex: 86400 })
    if (locked === null && (await kv.get<string>(lockKey)) !== key) {
      return NextResponse.json({ error: 'Une relance est déjà en cours d’envoi pour ce mail. Vérifie la page Suivi.' }, { status: 409 })
    }

    const { entry, sender, sentBy } = check
    const messageId = await originalMessageId(id, entry)
    if (!messageId) console.warn('[RELANCE] Message-ID inconnu, relance envoyée hors du fil :', id)

    const { status, body } = await deliverMail({
      commercial: { name: sender.name, email: sender.email, hubspot_id: sender.hubspot_id, slack_user_id: sender.slack_user_id },
      ps: { id: String(entry.contact_id || ''), titre: entry.ps_titre || '', nom: entry.ps_lastname || '', prenom: '', email: entry.ps_email, rpps: entry.ps_rpps || '' },
      formation: { nom: entry.formation_nom || '', numero: entry.formation_numero || '' },
      sujet,
      corps,
      idempotencyKey: key,
      sentBy,
      kind: 'relance',
      parentId: id,
      headers: messageId ? { 'In-Reply-To': messageId, References: messageId } : undefined,
    })

    if (status !== 200 || !body.resend_id) {
      // Rien n'est parti : la relance peut être retentée
      if (status >= 500) await kv.del(lockKey)
      return NextResponse.json(body, { status })
    }
    try {
      await attachRelance(id, body.resend_id)
    } catch (e: any) {
      console.error('[RELANCE] Rattachement au mail d’origine impossible :', id, e.message)
    }
    return NextResponse.json({ ...body, in_reply_to: !!messageId })
  } catch (e: any) {
    console.error('[RELANCE] Envoi impossible :', e.message)
    return NextResponse.json({ error: "La relance n'a pas pu être envoyée. Réessaie dans quelques instants ; si le problème persiste, préviens Déthié." }, { status: 500 })
  }
}
