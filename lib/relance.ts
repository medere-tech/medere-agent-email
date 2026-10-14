import { Resend } from 'resend'
import { getKv } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { STATUT_ACTIF, adminFiche, normalizeEmail, type Fiche } from '@/lib/roles'
import type { Actor } from '@/lib/identity'
import { adminProfile } from '@/lib/config'
import { SMS_TIP, dpcStepsText } from '@/lib/dpc-steps'
import { RELANCE_MESSAGES, selectRelanceSessions, sessionLabels, sessionNumbersIn, sessionOuverte, type RelanceMode } from '@/lib/session-label'
import { getFormationSessions, getFormationsActives, type Session } from '@/lib/airtable'
import { today as todayParis } from '@/lib/dev-today'

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

  // La relance part au nom du commercial du mail d'origine, s'il est toujours actif. Mail envoyé
  // par l'administrateur en son nom : relancé au nom de son profil (variables ADMIN_*), quel que
  // soit l'état de sa fiche Airtable.
  const admin = adminProfile()
  const adminSender = admin && authorEmail && authorEmail === normalizeEmail(admin.email) ? adminFiche(admin) : null
  const sender = adminSender || actor.fiches.find((f) =>
    f.statut === STATUT_ACTIF && (authorEmail ? normalizeEmail(f.email) === authorEmail : f.name.trim() === String(entry.commercial_name || '').trim()))
  if (!sender) return { ok: false, status: 409, error: "Le commercial qui a envoyé ce mail n'est plus actif : relance impossible." }
  const sentBy = !isAuthor ? { email: actor.email, name: actor.name } : undefined
  return { ok: true, entry, sender, sentBy }
}

// Sessions à présenter dans la relance, relues dans Airtable (cache) à chaque préparation, rédaction
// et envoi, avec la règle d'ouverture de l'étape 3 (sessionOuverte) :
//   origine      : sessions du mail d'origine encore ouvertes (uniquement celles-là)
//   remplacement : toutes passées → prochaines sessions ouvertes de la formation (3 au plus)
//   inconnues    : sessions du mail d'origine introuvables → prochaines sessions ouvertes (3 au plus)
//   aucune       : aucune session ouverte (ou formation plus active) → relance impossible
// Libellés calculés par lib/session-label (jours de la semaine exacts).
export interface RelanceSessions {
  format: string
  sessions: Session[]
  mode: RelanceMode
  message: string | null
  // Numéros de toutes les sessions de la formation, et de celles encore ouvertes (contrôle du texte)
  numerosFormation: string[]
  numerosOuverts: string[]
  today: string
}

export async function relanceSessions(id: string, entry: Record<string, any>): Promise<RelanceSessions> {
  const today = todayParis()
  const numero = String(entry.formation_numero || '').trim()
  const formation = numero ? (await getFormationsActives()).find((f) => String(f.numero).trim() === numero) : undefined
  if (!formation) return { format: '', sessions: [], mode: 'aucune', message: RELANCE_MESSAGES.aucune, numerosFormation: [], numerosOuverts: [], today }
  const all = await getFormationSessions(formation.id)
  const ouvertes = all.filter((s) => sessionOuverte(s, formation.format, today))
  const origine = await origineNumeros(id, entry, all)
  const { mode, sessions } = selectRelanceSessions(origine, ouvertes)
  return {
    format: formation.format,
    sessions,
    mode,
    message: RELANCE_MESSAGES[mode],
    numerosFormation: Array.from(new Set(all.map((s) => String(s.numero)).filter(Boolean))),
    numerosOuverts: Array.from(new Set(ouvertes.map((s) => String(s.numero)).filter(Boolean))),
    today,
  }
}

// La formation a-t-elle encore une session ouverte ? (bouton « Relancer » de /suivi ; null = inconnu)
export async function formationOuverte(numero: string): Promise<boolean | null> {
  try {
    const formation = (await getFormationsActives()).find((f) => String(f.numero).trim() === String(numero || '').trim())
    if (!formation) return false
    const today = todayParis()
    return (await getFormationSessions(formation.id)).some((s) => sessionOuverte(s, formation.format, today))
  } catch (e: any) {
    console.error('[RELANCE] Sessions indisponibles :', e.message)
    return null
  }
}

// Numéros des sessions du mail d'origine : enregistrés à l'envoi (session_numeros, session_ids) ;
// mails envoyés avant cet enregistrement : numéros de session de la formation retrouvés dans le texte
// du mail, relu chez Resend (jamais stocké ; seuls les numéros trouvés sont gardés 10 minutes en
// mémoire). null : introuvables (texte expiré chez Resend, aucun numéro cité).
const ORIGINE_TTL_MS = 10 * 60 * 1000
const origineCache = new Map<string, { at: number; numeros: string[] | null }>()

async function origineNumeros(id: string, entry: Record<string, any>, all: Session[]): Promise<string[] | null> {
  if (Array.isArray(entry.session_numeros) && entry.session_numeros.length) return entry.session_numeros.map(String)
  if (Array.isArray(entry.session_ids) && entry.session_ids.length) {
    const found = all.filter((s) => entry.session_ids.includes(s.id)).map((s) => s.numero)
    if (found.length) return found
  }
  const hit = origineCache.get(id)
  if (hit && Date.now() - hit.at < ORIGINE_TTL_MS) return hit.numeros
  let numeros: string[] | null = null
  try {
    const { data } = await resend.emails.get(id)
    const text = String((data as any)?.text || '') || String((data as any)?.html || '').replace(/<[^>]+>/g, ' ')
    const found = sessionNumbersIn(text, all.map((s) => s.numero))
    numeros = found.length ? found : null
  } catch (e: any) {
    console.error('[RELANCE] Texte du mail d’origine indisponible :', e.message)
  }
  if (!numeros) console.warn('[RELANCE] Sessions du mail d’origine introuvables, prochaines sessions proposées :', id)
  origineCache.set(id, { at: Date.now(), numeros })
  return numeros
}

// Sessions citées dans le texte qui ne sont plus ouvertes à l'inscription (envoi bloqué)
export function sessionsFermeesCitees(text: string, rs: RelanceSessions): string[] {
  return sessionNumbersIn(text, rs.numerosFormation).filter((n) => !rs.numerosOuverts.includes(n))
}

export function sessionsFermeesMessage(numeros: string[]): string {
  return numeros.length > 1
    ? `Les sessions ${numeros.join(', ')} ne sont plus ouvertes à l'inscription : retire-les du texte de la relance.`
    : `La session ${numeros[0]} n'est plus ouverte à l'inscription : retire-la du texte de la relance.`
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
export function relanceDraft(entry: Record<string, any>, { format, sessions }: Pick<RelanceSessions, 'format' | 'sessions'>, sender: { name: string; email?: string; phone?: string }): string {
  const titre = String(entry.ps_titre || '').trim()
  const nom = String(entry.ps_lastname || '').trim()
  const greeting = titre && nom ? `Bonjour ${titre} ${nom},` : 'Bonjour,'
  const formation = String(entry.formation_nom || '').trim()
  const date = frenchDate(entry.sent_at)
  const parts = [
    greeting, '',
    `Je me permets de revenir vers vous concernant la formation « ${formation} », dont je vous ai transmis les informations${date ? ` le ${date}` : ''}. Cette formation est intégralement prise en charge par l'ANDPC.`, '',
  ]
  if (sessions.length) parts.push(sessions.length > 1 ? 'Voici les sessions disponibles :' : 'Voici la session disponible :', sessionLabels(sessions, format), '')
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
// v: 2 = relance neutre (sans statut ni mail d'origine recopié) ; v: 3 = sessions recopiées depuis les
// libellés calculés dans le code (jours de la semaine exacts). Un brouillon d'un format antérieur est
// ignoré et rédigé de nouveau. sessions : numéros des sessions proposées au moment de la rédaction
// (absent des brouillons rédigés avant : numéros relus dans le texte). Un brouillon dont les sessions
// ne correspondent plus aux sessions proposées ce jour est ignoré et rédigé de nouveau (draftAJour).
export const STORED_RELANCE_VERSION = 3

export interface StoredRelance {
  v: number
  corps: string
  generated_at: string
  generated_by: string
  sessions?: string[]
}

export async function storedRelance(id: string): Promise<StoredRelance | null> {
  const d = await getKv().get<StoredRelance>(KEYS.relanceDraft(id))
  return d && d.v === STORED_RELANCE_VERSION && typeof d.corps === 'string' && d.corps ? d : null
}

export function draftAJour(d: StoredRelance, rs: RelanceSessions): boolean {
  if (rs.mode === 'aucune') return false
  const drafted = Array.isArray(d.sessions) ? d.sessions.map(String) : sessionNumbersIn(d.corps, rs.numerosFormation)
  const current = rs.sessions.map((s) => String(s.numero))
  return drafted.length === current.length && current.every((n) => drafted.includes(n))
}
