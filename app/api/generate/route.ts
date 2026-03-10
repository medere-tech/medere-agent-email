import { NextRequest, NextResponse } from 'next/server'
import { generateMail } from '@/lib/claude'
import { getFormationsUpsell, getFormationsDejaFaites } from '@/lib/airtable'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { commercial, formation, sessions, ps } = body

    if (!commercial || !formation || !sessions?.length || !ps) {
      return NextResponse.json({ error: 'Données manquantes' }, { status: 400 })
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

    const result = await generateMail({
      commercial,
      formation,
      sessions,
      ps,
      formationsLiees,
    })

    return NextResponse.json({ sujet: result.sujet, corps: result.corps })
  } catch (e: any) {
    console.error('Generate error:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}