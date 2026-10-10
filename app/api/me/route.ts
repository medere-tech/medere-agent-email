import { NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'

// Personne connectée : rôle et fiche commercial, pour l'étape 1 et la page de suivi.
// Un compte « Plus actif » reçoit 403 (bloqué partout).
export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireActor({ readOnly: true })
  if (!guard.ok) return guard.response
  const { actor } = guard
  return NextResponse.json({
    email: actor.email,
    name: actor.name,
    role: actor.role,
    commercial: actor.fiche ? { id: actor.fiche.id, name: actor.fiche.name, email: actor.fiche.email } : null,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
