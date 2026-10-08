import { NextRequest, NextResponse } from 'next/server'
import { searchContacts } from '@/lib/hubspot'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')
  if (!q || q.length < 2) return NextResponse.json({ contacts: [] })

  try {
    const contacts = await searchContacts(q)
    return NextResponse.json({ contacts })
  } catch (e: any) {
    console.error('[CONTACT-SEARCH] HubSpot indisponible:', e.message)
    return NextResponse.json({ error: 'HubSpot indisponible, ne crée pas le contact. Réessaie dans quelques instants.' }, { status: 502 })
  }
}