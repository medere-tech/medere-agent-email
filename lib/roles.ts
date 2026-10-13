// Rôles et choix du commercial expéditeur — fonctions pures, sans import (testables avec Node).
//
//   admin      : email du profil administrateur (variables ADMIN_*, voir lib/config.ts) — accès complet
//                quel que soit l'état de sa fiche Airtable (absente, « Plus actif », supprimée) ; envoie
//                en son nom (profil défini dans les variables) ou au nom de n'importe quel commercial
//                actif ; une action au nom d'un autre commercial est tracée (sent_by)
//   commercial : fiche Commerciaux « Actif » — n'agit qu'en son nom, quoi que le navigateur envoie
//   lecteur    : compte @medere.fr sans fiche — /suivi en lecture seule
//   inactif    : fiche présente mais pas « Actif » (personne partie de Médéré) — bloqué partout,
//                sauf l'administrateur

export type Role = 'admin' | 'commercial' | 'lecteur' | 'inactif'

export interface Fiche {
  id: string
  name: string
  email: string
  phone: string
  hubspot_id: string
  slack_user_id: string
  statut: string
}

export const STATUT_ACTIF = 'Actif'

// Identifiant réservé de la « fiche » de l'administrateur (profil des variables d'environnement,
// jamais une fiche Airtable) : choisi à l'étape 1 pour envoyer en son propre nom.
export const ADMIN_SELF_ID = 'admin:self'

export function normalizeEmail(email: string | undefined | null): string {
  return String(email || '').trim().toLowerCase()
}

// Fiche construite à partir du profil administrateur
export function adminFiche(profile: { email: string; name: string; hubspot_id: string; slack_user_id: string; phone?: string }): Fiche {
  return {
    id: ADMIN_SELF_ID,
    name: profile.name,
    email: normalizeEmail(profile.email),
    phone: profile.phone || '',
    hubspot_id: profile.hubspot_id,
    slack_user_id: profile.slack_user_id,
    statut: STATUT_ACTIF,
  }
}

// Fiche d'un compte Google (rapprochement par email). Plusieurs fiches pour un même email :
// la fiche active est prioritaire (une ancienne fiche « Plus actif » ne bloque pas une nouvelle).
export function findFiche(email: string, fiches: Fiche[]): Fiche | null {
  const e = normalizeEmail(email)
  if (!e) return null
  const matches = fiches.filter((f) => normalizeEmail(f.email) === e)
  return matches.find((f) => f.statut === STATUT_ACTIF) || matches[0] || null
}

// L'administrateur passe avant l'état de sa fiche : il n'est jamais « inactif »
export function computeRole(email: string, fiche: Fiche | null, admins: readonly string[]): Role {
  if (admins.map(normalizeEmail).includes(normalizeEmail(email))) return 'admin'
  if (fiche && fiche.statut !== STATUT_ACTIF) return 'inactif'
  return fiche ? 'commercial' : 'lecteur'
}

// Messages affichés (vocabulaire sans terme technique)
export const ROLE_MESSAGES = {
  inactif: "Ton accès à l'Agent Mail a été désactivé. Si c'est une erreur, préviens Déthié.",
  lecteur: "Ton compte n'est pas associé à une fiche commercial : tu peux consulter le suivi, mais pas générer ni envoyer de mail.",
  notOwn: 'Tu ne peux générer et envoyer des mails qu’en ton nom.',
  inactiveTarget: "Ce commercial n'est pas actif : choisis-en un autre.",
} as const

export type SenderResult =
  | { ok: true; sender: Fiche; onBehalf: boolean }
  | { ok: false; status: number; error: string }

// Commercial au nom duquel générer / envoyer. requestedId vient du navigateur : il n'est
// accepté que pour un administrateur, et seulement s'il désigne une fiche active (ou ADMIN_SELF_ID).
// Pour un administrateur, own est la fiche construite à partir de son profil (adminFiche).
export function resolveSender(
  role: Role,
  own: Fiche | null,
  requestedId: string | undefined | null,
  fiches: Fiche[]
): SenderResult {
  if (role === 'inactif') return { ok: false, status: 403, error: ROLE_MESSAGES.inactif }
  if (role === 'lecteur') return { ok: false, status: 403, error: ROLE_MESSAGES.lecteur }
  const requested = requestedId ? String(requestedId) : ''

  if (role === 'commercial') {
    if (!own) return { ok: false, status: 403, error: ROLE_MESSAGES.lecteur }
    if (requested && requested !== own.id) return { ok: false, status: 403, error: ROLE_MESSAGES.notOwn }
    return { ok: true, sender: own, onBehalf: false }
  }

  // admin : en son nom par défaut
  if (!own) return { ok: false, status: 403, error: ROLE_MESSAGES.lecteur }
  if (!requested || requested === own.id) return { ok: true, sender: own, onBehalf: false }
  const target = fiches.find((f) => f.id === requested)
  if (!target || target.statut !== STATUT_ACTIF) return { ok: false, status: 400, error: ROLE_MESSAGES.inactiveTarget }
  // Sa propre fiche Airtable (si elle est active) : même personne, pas « au nom de »
  return { ok: true, sender: target, onBehalf: normalizeEmail(target.email) !== normalizeEmail(own.email) }
}
