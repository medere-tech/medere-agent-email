import { NextRequest, NextResponse } from 'next/server'
import { generateMail } from '@/lib/claude'
import { getFormationsUpsell, getFormationsDejaFaites } from '@/lib/airtable'
import { requireActor, senderFor } from '@/lib/identity'
import { checkRateLimit, rateLimitMessage } from '@/lib/ratelimit'

export async function POST(req: NextRequest) {
  try {
    // Identité relue côté serveur : aucun commercial venant du navigateur n'est cru
    const guard = await requireActor()
    if (!guard.ok) return guard.response
    const { actor } = guard

    const body = await req.json()
    const { commercial_id, formation, sessions, ps } = body

    const resolved = senderFor(actor, commercial_id)
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    const sender = resolved.sender

    const limit = await checkRateLimit('generate', actor.email)
    if (!limit.ok) return NextResponse.json({ error: rateLimitMessage('generate', limit.retryAfterSeconds) }, { status: 429 })

    if (!formation || !sessions?.length || !ps) {
      return NextResponse.json({ error: 'Il manque des informations : vérifie la formation, les sessions et le contact.' }, { status: 400 })
    }

    // Upsell intelligent : formations actives, même public, session disponible juste après en tenant compte de la spécialité du PS, de la date de fin max des sessions sélectionnées, et que le PS n'a pas déjà faites
    let formationsLiees: Array<{ nom: string; format: string; prochaineSession?: string }> = []
    try {
      if (formation.public?.length) {
        // Date de fin la plus tardive des sessions sélectionnées par le PS
        // Priorité : date_cv2 (2ème soirée CV) > date_fin > date_cv1
        // Pour les classes virtuelles à 2 soirées, date_cv2 est la vraie date de fin
        const dateFinMax = sessions
          .map((s: any) => s.date_cv2 || s.date_fin || s.date_cv1 || '')
          .filter(Boolean)
          .sort()
          .at(-1) || new Date().toISOString().slice(0, 10)

        const dejaFaites = await getFormationsDejaFaites(ps.rpps || '', ps.email || '')

        formationsLiees = await getFormationsUpsell(
          formation.id,
          formation.public,
          dateFinMax,
          dejaFaites,
          ps.specialite || ''
        )
      }
    } catch (e) {
      console.error('[UPSELL] Erreur:', e)
      // Non-blocking
    }

    if (resolved.onBehalf) console.log('[GENERATE] Génération par', actor.email, 'au nom de', sender.email)
    const result = await generateMail({
      commercial: { name: sender.name, email: sender.email, phone: sender.phone },
      formation,
      sessions,
      ps,
      formationsLiees,
    })

    return NextResponse.json({ sujet: result.sujet, corps: result.corps })
  } catch (e: any) {
    console.error('Generate error:', e)
    return NextResponse.json({ error: 'La rédaction du mail a échoué. Réessaie.' }, { status: 500 })
  }
}