import { NextResponse } from 'next/server'
import { getCommerciauxActifs } from '@/lib/airtable'

export async function GET() {
  try {
    const commerciaux = await getCommerciauxActifs()
    return NextResponse.json({ commerciaux })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
