import { NextRequest, NextResponse } from 'next/server'
import { searchContacts, type SearchPart } from '@/lib/hubspot'
import { requireActor } from '@/lib/identity'

export const dynamic = 'force-dynamic'

// POST (corps JSON { q, part }) : la recherche (souvent un email ou un nom de PS) n'apparaît jamais
// dans l'adresse de la requête, donc jamais dans les journaux d'accès (Vercel).
export async function POST(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response

  const body = await req.json().catch(() => ({}))
  const q = typeof body?.q === 'string' ? body.q : ''
  if (q.length < 2) return NextResponse.json({ contacts: [] })

  try {
    // part=first : première passe (affichée tout de suite) ; part=rest : passes complémentaires
    const p = body?.part
    const part: SearchPart = p === 'first' || p === 'rest' ? p : 'all'
    const contacts = await searchContacts(q, part)
    return NextResponse.json({ contacts })
  } catch (e: any) {
    console.error('[CONTACT-SEARCH] HubSpot indisponible:', e.message)
    return NextResponse.json({ error: 'HubSpot indisponible, ne crée pas le contact. Réessaie dans quelques instants.' }, { status: 502 })
  }
}
