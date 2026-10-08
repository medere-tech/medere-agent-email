import { NextResponse } from 'next/server'
import { getCommerciauxActifs } from '@/lib/airtable'

export async function GET() {
  try {
    const commerciaux = await getCommerciauxActifs()
    return NextResponse.json({ commerciaux })
  } catch (e: any) {
    console.error('[COMMERCIAUX] Chargement impossible:', e.message)
    return NextResponse.json({ error: 'Impossible de charger la liste des commerciaux. Réessaie dans quelques instants.' }, { status: 500 })
  }
}
