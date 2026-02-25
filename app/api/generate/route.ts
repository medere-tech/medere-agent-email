import { NextRequest, NextResponse } from 'next/server'
import { generateMail } from '@/lib/claude'
import { getFormationsParPublic } from '@/lib/airtable'

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
        const liees = await getFormationsParPublic(formation.public)
        formationsLiees = liees
          .filter((f) => f.id !== formation.id) // exclude current
          .slice(0, 3) // max 3 upsell
          .map((f) => ({ nom: f.nom, format: f.format }))
      }
    } catch {
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
