import { NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { today } from '@/lib/dev-today'

// Personne connectée : rôle et fiche commercial, pour l'étape 1 et la page de suivi. aujourdhui :
// date du jour du serveur (Paris), pour signaler à l'étape 5 les dates de session déjà passées.
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
    aujourdhui: today(),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
