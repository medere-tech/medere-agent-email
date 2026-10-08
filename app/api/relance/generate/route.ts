import { NextRequest, NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { checkRateLimit, rateLimitMessage } from '@/lib/ratelimit'
import { checkRelance, originalBody, relanceStatus } from '@/lib/relance'
import { generateRelance } from '@/lib/claude'

// Relance rédigée par Claude (adaptée au statut), à relire et modifier avant l'envoi
export async function POST(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response
  const { actor } = guard
  try {
    const { id } = await req.json()
    const check = await checkRelance(actor, String(id || ''))
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })

    const limit = await checkRateLimit('generate', actor.email)
    if (!limit.ok) return NextResponse.json({ error: rateLimitMessage('generate', limit.retryAfterSeconds) }, { status: 429 })

    const { entry, sender } = check
    const corps = await generateRelance({
      commercial: { name: sender.name, email: sender.email, phone: sender.phone },
      ps: { titre: entry.ps_titre || '', nom: entry.ps_lastname || '' },
      formationNom: entry.formation_nom || '',
      statut: relanceStatus(entry),
      sentAt: entry.sent_at || '',
      originalBody: await originalBody(String(id)),
    })
    return NextResponse.json({ corps })
  } catch (e: any) {
    console.error('[RELANCE] Rédaction impossible :', e.message)
    return NextResponse.json({ error: 'La rédaction de la relance a échoué. Réessaie.' }, { status: 500 })
  }
}
