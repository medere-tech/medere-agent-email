import { NextRequest, NextResponse } from 'next/server'
import { searchContacts, type SearchPart } from '@/lib/hubspot'
import { requireActor } from '@/lib/identity'

export async function GET(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response

  const q = req.nextUrl.searchParams.get('q')
  if (!q || q.length < 2) return NextResponse.json({ contacts: [] })

  try {
    // part=first : première passe (affichée tout de suite) ; part=rest : passes complémentaires
    const p = req.nextUrl.searchParams.get('part')
    const part: SearchPart = p === 'first' || p === 'rest' ? p : 'all'
    const contacts = await searchContacts(q, part)
    return NextResponse.json({ contacts })
  } catch (e: any) {
    console.error('[CONTACT-SEARCH] HubSpot indisponible:', e.message)
    return NextResponse.json({ error: 'HubSpot indisponible, ne crée pas le contact. Réessaie dans quelques instants.' }, { status: 502 })
  }
}
