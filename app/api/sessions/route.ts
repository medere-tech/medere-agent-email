import { NextRequest, NextResponse } from 'next/server'
import { getSessionsByFormation, warmSessionsCache } from '@/lib/airtable'
import { requireActor } from '@/lib/identity'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response

  try {
    // ?warm=1 : préchauffe le cache des sessions dès l'arrivée sur l'assistant
    if (req.nextUrl.searchParams.get('warm') === '1') {
      return NextResponse.json({ warmed: await warmSessionsCache() })
    }

    const formationId = req.nextUrl.searchParams.get('formationId')
    const formationFormat = req.nextUrl.searchParams.get('format') || ''
    if (!formationId) return NextResponse.json({ error: "Choisis d'abord une formation." }, { status: 400 })

    const sessions = await getSessionsByFormation(formationId, formationFormat)
    return NextResponse.json({ sessions })
  } catch (e: any) {
    console.error('[SESSIONS] Chargement impossible:', e.message)
    return NextResponse.json({ error: 'Impossible de charger les sessions. Réessaie dans quelques instants.' }, { status: 500 })
  }
}
