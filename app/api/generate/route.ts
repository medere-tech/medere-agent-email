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

    // Upsell intelligent : formations actives, même public, session disponible juste après
    let formationsLiees: Array<{ nom: string; format: string; prochaineSession?: string }> = []
    try {
      if (formation.public?.length) {
        // Date de fin la plus tardive des sessions sélectionnées par le PS
        const dateFinMax = sessions
          .map((s: any) => s.date_fin || s.date_cv1 || '')
          .filter(Boolean)
          .sort()
          .at(-1) || new Date().toISOString().slice(0, 10)

        const dejaFaites = await getFormationsDejaFaites(ps.rpps || '', ps.email || '')

        formationsLiees = await getFormationsUpsell(
          formation.id,
          formation.public,
          dateFinMax,
          dejaFaites
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