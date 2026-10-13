import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getAllFiches } from '@/lib/airtable'
import { adminEmails, adminProfile } from '@/lib/config'
import { ROLE_MESSAGES, adminFiche, computeRole, findFiche, normalizeEmail, resolveSender, type Fiche, type Role, type SenderResult } from '@/lib/roles'

// Personne connectée, relue côté serveur à chaque requête (session Google + fiche Airtable,
// cache strict de COMMERCIAL_CACHE_SECONDS). Le navigateur ne fournit jamais l'identité.
// Administrateur : sa « fiche » est son profil (variables ADMIN_*), jamais sa fiche Airtable.
export interface Actor {
  email: string
  name: string
  role: Role
  fiche: Fiche | null
  fiches: Fiche[]
}

// ─── Mode de test du rôle (développement local uniquement) ────────────────────
// DEV_FORCE_ROLE=commercial|lecteur|inactif fait passer la session de l'administrateur pour ce rôle,
// sans toucher à Airtable (commercial : fiche fictive construite à partir du profil administrateur,
// identifiant dev:commercial). Actif seulement si NODE_ENV vaut « development » (npm run dev) ET que
// VERCEL n'est pas défini : npm run build / next start fixent NODE_ENV à « production », et VERCEL
// est toujours défini sur Vercel. Présente ailleurs, la variable est ignorée et une erreur journalisée.
export const DEV_FORCE_ROLES = ['commercial', 'lecteur', 'inactif'] as const
export const DEV_COMMERCIAL_ID = 'dev:commercial'
let devLogged = ''

export function devForcedRole(): (typeof DEV_FORCE_ROLES)[number] | null {
  const value = String(process.env.DEV_FORCE_ROLE || '').trim()
  if (!value) return null
  const log = (key: string, fn: () => void) => { if (devLogged !== key) { devLogged = key; fn() } }
  if (process.env.NODE_ENV !== 'development' || process.env.VERCEL) {
    log('refus', () => console.error('[IDENTITE] DEV_FORCE_ROLE présent hors développement local : variable ignorée. Retire-la de cet environnement.'))
    return null
  }
  if (!(DEV_FORCE_ROLES as readonly string[]).includes(value)) {
    log('inconnu', () => console.warn(`[IDENTITE] DEV_FORCE_ROLE inconnu (${value}) : ignoré. Valeurs : ${DEV_FORCE_ROLES.join(', ')}.`))
    return null
  }
  log(value, () => console.warn(`[IDENTITE] MODE TEST (développement local) : la session administrateur est traitée comme « ${value} ».`))
  return value as (typeof DEV_FORCE_ROLES)[number]
}

export async function getActor(): Promise<Actor | null> {
  const session = await getSession()
  if (!session?.email) return null
  const fiches = await getAllFiches()
  const email = normalizeEmail(session.email)
  const admin = adminProfile()
  const role = computeRole(email, findFiche(email, fiches), adminEmails())

  if (role === 'admin' && admin) {
    const forced = devForcedRole()
    const own = adminFiche(admin)
    if (forced === 'commercial') return { email, name: admin.name, role: 'commercial', fiche: { ...own, id: DEV_COMMERCIAL_ID }, fiches }
    if (forced === 'lecteur') return { email, name: admin.name, role: 'lecteur', fiche: null, fiches }
    if (forced === 'inactif') return { email, name: admin.name, role: 'inactif', fiche: { ...own, id: DEV_COMMERCIAL_ID, statut: 'Plus actif' }, fiches }
    return { email, name: admin.name, role, fiche: own, fiches }
  }
  const fiche = findFiche(email, fiches)
  return { email, name: fiche?.name || session.name || email, role, fiche, fiches }
}

type Guard = { ok: true; actor: Actor } | { ok: false; response: NextResponse }

// Contrôle commun des routes métier. readOnly : un lecteur (compte sans fiche) est accepté.
// Une fiche « Plus actif » est refusée partout (l'administrateur n'est jamais « inactif »).
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
