import { NextResponse } from 'next/server'
import { getFormationsActives } from '@/lib/airtable'

export async function GET() {
  try {
    const formations = await getFormationsActives()
    return NextResponse.json({ formations })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
