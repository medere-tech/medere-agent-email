import { NextRequest, NextResponse } from 'next/server'
import { getSessionsByFormation } from '@/lib/airtable'

export async function GET(req: NextRequest) {
  const formationId = req.nextUrl.searchParams.get('formationId')
  const formationFormat = req.nextUrl.searchParams.get('format') || ''
  if (!formationId) return NextResponse.json({ error: 'formationId requis' }, { status: 400 })

  try {
    const sessions = await getSessionsByFormation(formationId, formationFormat)
    return NextResponse.json({ sessions })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
