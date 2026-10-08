import { Resend } from 'resend'
import { getKv } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { STATUT_ACTIF, normalizeEmail, type Fiche } from '@/lib/roles'
import type { Actor } from '@/lib/identity'
import { SMS_TIP, dpcStepsText, sessionsText, type SessionForText } from '@/lib/dpc-steps'
import { getFormationsActives, getSessionsByFormation } from '@/lib/airtable'

const resend = new Resend(process.env.RESEND_API_KEY!)

// Relance par mail depuis /suivi : un seul envoi de relance par mail d'origine, par son auteur
// (ou un administrateur, tracé), jamais en cas d'adresse invalide ou de mail signalé indésirable.

export type RelanceStatus = 'non_ouvert' | 'ouvert_sans_clic' | 'clique'

export function relanceStatus(e: Record<string, any>): RelanceStatus {
  if (e.first_clicked_at || e.clicked_at || e.statut === 'cliqué') return 'clique'
  if (e.first_opened_at || e.opened_at || e.statut === 'ouvert') return 'ouvert_sans_clic'
  return 'non_ouvert'
}

export const RELANCE_STATUS_LABEL: Record<RelanceStatus, string> = {
  non_ouvert: 'non ouvert',
  ouvert_sans_clic: 'ouvert, sans clic',
  clique: 'cliqué',
}

export type RelanceCheck =
  | { ok: true; entry: Record<string, any>; sender: Fiche; sentBy?: { email: string; name: string } }
  | { ok: false; status: number; error: string }

// Le mail peut-il être relancé par cette personne ? (mêmes règles pour préparer et envoyer)
export async function checkRelance(actor: Actor, id: string): Promise<RelanceCheck> {
  const entry = id ? await getKv().get<Record<string, any>>(KEYS.track(id)) : null
  return relanceVerdict(actor, entry)
}

// Verdict sans lecture du KV (aussi utilisé par /api/suivi pour activer ou non le bouton « Relancer »)
export function relanceVerdict(actor: Actor, entry: Record<string, any> | null): RelanceCheck {
  if (!entry) return { ok: false, status: 404, error: 'Ce mail est introuvable dans le suivi.' }
  if (actor.role !== 'admin' && actor.role !== 'commercial') return { ok: false, status: 403, error: "Ton compte ne permet pas d'envoyer de relance." }
  if (entry.kind === 'relance') return { ok: false, status: 400, error: 'Ce mail est déjà une relance.' }
  if (entry.relance_id) return { ok: false, status: 409, error: 'Une relance a déjà été envoyée pour ce mail.' }
  if (entry.statut === 'bounce') return { ok: false, status: 409, error: 'Adresse invalide : ce PS ne peut pas être relancé par mail.' }
  if (entry.statut === 'plainte') return { ok: false, status: 409, error: 'Le PS a signalé ce mail comme indésirable : pas de relance.' }

  // Auteur : email du commercial enregistré à l'envoi (anciens envois : nom du commercial)
  const authorEmail = normalizeEmail(entry.commercial_email)
  const isAuthor = authorEmail
    ? normalizeEmail(actor.fiche?.email) === authorEmail
    : !!actor.fiche && actor.fiche.name.trim() === String(entry.commercial_name || '').trim()
  if (!isAuthor && actor.role !== 'admin') {
    return { ok: false, status: 403, error: "Seul le commercial qui a envoyé ce mail peut le relancer." }
  }

  // La relance part au nom du commercial du mail d'origine, s'il est toujours actif
  const sender = actor.fiches.find((f) =>
    f.statut === STATUT_ACTIF && (authorEmail ? normalizeEmail(f.email) === authorEmail : f.name.trim() === String(entry.commercial_name || '').trim()))
  if (!sender) return { ok: false, status: 409, error: "Le commercial qui a envoyé ce mail n'est plus actif : relance impossible." }
  const sentBy = !isAuthor ? { email: actor.email, name: actor.name } : undefined
  return { ok: true, entry, sender, sentBy }
}

// Sessions à présenter dans la relance : prochaines sessions de la formation (par numéro DPC),
// relues dans le cache Airtable (jamais attendu) ; au plus 3. Aucune session trouvée → liste vide.
export async function relanceSessions(entry: Record<string, any>): Promise<SessionForText[]> {
  const numero = String(entry.formation_numero || '').trim()
  if (!numero) return []
  try {
    const formation = (await getFormationsActives()).find((f) => String(f.numero).trim() === numero)
    if (!formation) return []
    return (await getSessionsByFormation(formation.id, formation.format)).slice(0, 3)
  } catch (e: any) {
    console.error('[RELANCE] Sessions indisponibles :', e.message)
    return []
  }
}

// Message-ID du mail d'origine (fil de discussion) : reçu par webhook, sinon demandé à Resend
export async function originalMessageId(id: string, entry: Record<string, any>): Promise<string | null> {
  if (entry.message_id) return String(entry.message_id)
  try {
    const { data } = await resend.emails.get(id)
    return data?.message_id || null
  } catch (e: any) {
    console.error('[RELANCE] Message-ID indisponible :', e.message)
    return null
  }
}

function frenchDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' }).format(new Date(iso))
  } catch {
    return ''
  }
}

export function relanceSubject(entry: Record<string, any>): string {
  return `Relance : votre formation ${String(entry.formation_nom || '').trim()}`
}

// Brouillon de relance, IDENTIQUE quel que soit le statut du mail d'origine (RGPD : rien ne laisse
// deviner le suivi des ouvertures ou des clics) : formule d'appel, introduction neutre, sessions,
// parcours d'inscription à jour en 7 étapes, signature. Le mail d'origine n'est pas recopié.
export function relanceDraft(entry: Record<string, any>, sessions: SessionForText[], sender: { name: string; email?: string; phone?: string }): string {
  const titre = String(entry.ps_titre || '').trim()
  const nom = String(entry.ps_lastname || '').trim()
  const greeting = titre && nom ? `Bonjour ${titre} ${nom},` : 'Bonjour,'
  const formation = String(entry.formation_nom || '').trim()
  const date = frenchDate(entry.sent_at)
  const parts = [
    greeting, '',
    `Je me permets de revenir vers vous concernant la formation « ${formation} », dont je vous ai transmis les informations${date ? ` le ${date}` : ''}. Cette formation est intégralement prise en charge par l'ANDPC.`, '',
  ]
  if (sessions.length) parts.push(sessions.length > 1 ? 'Voici les sessions disponibles :' : 'Voici la session disponible :', sessionsText(sessions), '')
  parts.push(
    "Pour vous inscrire, voici les étapes (l'ANDPC demande désormais un code reçu par SMS) :",
    dpcStepsText(String(entry.formation_numero || '')), '', SMS_TIP, '',
    "Je reste à votre disposition pour vous accompagner dans votre inscription.", '',
    'Bien cordialement,', '',
    ...[sender.name, sender.email, sender.phone].filter((x): x is string => !!x),
  )
  return parts.join('\n')
}

// Relance rédigée par Claude : une seule génération par mail d'origine. Le brouillon est gardé
// (relance_draft:{id}, purgé avec l'envoi) et renvoyé à toute demande suivante, sans appel à Claude.
// v: 2 = relance neutre (sans statut ni mail d'origine recopié). Un brouillon d'un format antérieur
// est ignoré et rédigé de nouveau.
export const STORED_RELANCE_VERSION = 2

export interface StoredRelance {
  v: number
  corps: string
  generated_at: string
  generated_by: string
}

export async function storedRelance(id: string): Promise<StoredRelance | null> {
  const d = await getKv().get<StoredRelance>(KEYS.relanceDraft(id))
  return d && d.v === STORED_RELANCE_VERSION && typeof d.corps === 'string' && d.corps ? d : null
}
