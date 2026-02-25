import { NextRequest, NextResponse } from 'next/server'
import { searchContacts, searchContactsByName } from '@/lib/hubspot'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')
  if (!q || q.length < 2) return NextResponse.json({ contacts: [] })

  try {
    // Detect if it looks like a last name + first name
    const parts = q.trim().split(/\s+/)
    let contacts
    if (parts.length > 1) {
      contacts = await searchContactsByName(parts[0], parts[1])
    } else {
      contacts = await searchContacts(q)
    }
    return NextResponse.json({ contacts })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
