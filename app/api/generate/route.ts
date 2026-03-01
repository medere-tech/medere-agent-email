import { NextRequest, NextResponse } from 'next/server'
import { generateMail } from '@/lib/claude'
import { getFormationsParPublic, getFormationsDejaFaites } from '@/lib/airtable'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { commercial, formation, sessions, ps } = body

    if (!commercial || !formation || !sessions?.length || !ps) {
      return NextResponse.json({ error: 'Données manquantes' }, { status: 400 })
    }

    // Fetch related formations for upsell (same public cible)
    let formationsLiees: Array<{ nom: string; format: string }> = []
    try {
      if (formation.public?.length) {
        const dejaFaites = await getFormationsDejaFaites(ps.rpps || '', ps.email || '')
        console.log('[UPSELL] dejaFaites IDs:', dejaFaites)

        const liees = await getFormationsParPublic(formation.public)
        console.log('[UPSELL] Formations candidates (même public):', liees.map((f: any) => ({ id: f.id, nom: f.nom })))

        formationsLiees = liees
          .filter((f: any) => f.id !== formation.id)
          .filter((f: any) => !dejaFaites.includes(f.id))
          .slice(0, 3)
          .map((f: any) => ({ nom: f.nom, format: f.format }))

        console.log('[UPSELL] Formations retenues après filtrage:', formationsLiees)
      }
    } catch (e) {
      console.error('[UPSELL] Erreur dans le bloc upsell:', e)
      // Non-blocking - upsell is optional
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