import { NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { adminEmails } from '@/lib/config'
import { STATUT_ACTIF, normalizeEmail } from '@/lib/roles'

// Commerciaux actifs (liste de l'étape 1 pour un administrateur, filtres du suivi).
// Données relues côté serveur ; le cache des fiches est celui de lib/identity (strict, 60 s).
// Le profil administrateur n'apparaît jamais dans la liste vue par les autres utilisateurs (ni
// sa fiche Airtable, même active) ; l'administrateur voit en tête « son nom » (profil des variables).
export const dynamic = 'force-dynamic'

export async function GET() {
  const guard = await requireActor({ readOnly: true })
  if (!guard.ok) return guard.response
  const { actor } = guard
  const admins = adminEmails()
  const commerciaux = actor.fiches
    .filter((f) => f.statut === STATUT_ACTIF && !admins.includes(normalizeEmail(f.email)))
    .map(({ id, name, email }) => ({ id, name, email }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
  if (actor.role === 'admin' && actor.fiche) {
    commerciaux.unshift({ id: actor.fiche.id, name: actor.fiche.name, email: actor.fiche.email })
  }
  return NextResponse.json({ commerciaux })
}
