import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getAllFiches } from '@/lib/airtable'
import { ADMIN_EMAILS } from '@/lib/config'
import { ROLE_MESSAGES, computeRole, findFiche, normalizeEmail, resolveSender, type Fiche, type Role, type SenderResult } from '@/lib/roles'

// Personne connectée, relue côté serveur à chaque requête (session Google + fiche Airtable,
// cache strict de COMMERCIAL_CACHE_SECONDS). Le navigateur ne fournit jamais l'identité.
export interface Actor {
  email: string
  name: string
  role: Role
  fiche: Fiche | null
  fiches: Fiche[]
}

export async function getActor(): Promise<Actor | null> {
  const session = await getSession()
  if (!session?.email) return null
  const fiches = await getAllFiches()
  const email = normalizeEmail(session.email)
  const fiche = findFiche(email, fiches)
  return { email, name: fiche?.name || session.name || email, role: computeRole(email, fiche, ADMIN_EMAILS), fiche, fiches }
}

type Guard = { ok: true; actor: Actor } | { ok: false; response: NextResponse }

// Contrôle commun des routes métier. readOnly : un lecteur (compte sans fiche) est accepté.
// Un commercial « Plus actif » est refusé partout, administrateur compris.
export async function requireActor({ readOnly = false }: { readOnly?: boolean } = {}): Promise<Guard> {
  let actor: Actor | null
  try {
    actor = await getActor()
  } catch (e: any) {
    console.error('[IDENTITE] Fiches Commerciaux illisibles :', e.message)
    return { ok: false, response: NextResponse.json({ error: 'Impossible de vérifier ton accès. Réessaie dans quelques instants.' }, { status: 503 }) }
  }
  if (!actor) return { ok: false, response: NextResponse.json({ error: 'Session expirée, reconnecte-toi.' }, { status: 401 }) }
  if (actor.role === 'inactif') {
    console.warn('[IDENTITE] Accès refusé (fiche non active) :', actor.email)
    return { ok: false, response: NextResponse.json({ error: ROLE_MESSAGES.inactif }, { status: 403 }) }
  }
  if (actor.role === 'lecteur' && !readOnly) {
    return { ok: false, response: NextResponse.json({ error: ROLE_MESSAGES.lecteur }, { status: 403 }) }
  }
  return { ok: true, actor }
}

// Commercial au nom duquel agir (voir resolveSender dans lib/roles.ts)
export function senderFor(actor: Actor, requestedId: unknown): SenderResult {
  return resolveSender(actor.role, actor.fiche, typeof requestedId === 'string' ? requestedId : null, actor.fiches)
}
