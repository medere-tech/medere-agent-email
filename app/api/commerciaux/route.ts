import { NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { STATUT_ACTIF } from '@/lib/roles'

// Commerciaux actifs (liste de l'étape 1 pour un administrateur, filtres du suivi).
// Données relues côté serveur ; le cache des fiches est celui de lib/identity (strict, 60 s).
export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireActor({ readOnly: true })
  if (!guard.ok) return guard.response
  const commerciaux = guard.actor.fiches
    .filter((f) => f.statut === STATUT_ACTIF)
    .map(({ id, name, email }) => ({ id, name, email }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  return NextResponse.json({ commerciaux })
}
