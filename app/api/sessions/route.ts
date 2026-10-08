import { NextRequest, NextResponse } from 'next/server'
import { getSessionsByFormation } from '@/lib/airtable'

export async function GET(req: NextRequest) {
  const formationId = req.nextUrl.searchParams.get('formationId')
  const formationFormat = req.nextUrl.searchParams.get('format') || ''
  if (!formationId) return NextResponse.json({ error: "Choisis d'abord une formation." }, { status: 400 })

  try {
    const sessions = await getSessionsByFormation(formationId, formationFormat)
    return NextResponse.json({ sessions })
  } catch (e: any) {
    console.error('[SESSIONS] Chargement impossible:', e.message)
    return NextResponse.json({ error: 'Impossible de charger les sessions. Réessaie dans quelques instants.' }, { status: 500 })
  }
}
