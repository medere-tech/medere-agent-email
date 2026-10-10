import { NextResponse } from 'next/server'
import { getFormationsActives } from '@/lib/airtable'
import { requireActor } from '@/lib/identity'

// Lecture Airtable sans cache (pagination) : jamais de rendu statique au build
export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireActor({ readOnly: true })
  if (!guard.ok) return guard.response
  try {
    const formations = await getFormationsActives()
    return NextResponse.json({ formations })
  } catch (e: any) {
    console.error('[FORMATIONS] Chargement impossible:', e.message)
    return NextResponse.json({ error: 'Impossible de charger la liste des formations. Réessaie dans quelques instants.' }, { status: 500 })
  }
}
