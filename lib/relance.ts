import { Resend } from 'resend'
import { getKv } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { STATUT_ACTIF, normalizeEmail, type Fiche } from '@/lib/roles'
import type { Actor } from '@/lib/identity'

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

// Corps du mail d'origine : KV (90 jours), sinon Resend, sinon null (relance sans le corps d'origine)
export async function originalBody(id: string): Promise<string | null> {
  try {
    const stored = await getKv().get<{ corps?: string }>(KEYS.body(id))
    if (stored?.corps) return stored.corps
  } catch (e: any) {
    console.error('[RELANCE] Corps KV illisible :', e.message)
  }
  try {
    const { data } = await resend.emails.get(id)
    if (data?.text) return data.text
    if (data?.html) return htmlToText(data.html)
  } catch (e: any) {
    console.error('[RELANCE] Corps indisponible chez Resend :', e.message)
  }
  return null
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

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, (_m, url, label) => (label === url ? url : `${label} (${url})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim()
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

// Brouillon de relance : formule d'appel, introduction adaptée au statut, rappel du mail d'origine
export function relanceDraft(entry: Record<string, any>, body: string | null, senderName: string): string {
  const titre = String(entry.ps_titre || '').trim()
  const nom = String(entry.ps_lastname || '').trim()
  const greeting = titre && nom ? `Bonjour ${titre} ${nom},` : 'Bonjour,'
  const formation = String(entry.formation_nom || '').trim()
  const date = frenchDate(entry.sent_at)
  const intro: Record<RelanceStatus, string> = {
    non_ouvert: `Je me permets de revenir vers vous au sujet de la formation « ${formation} », dont je vous ai transmis les informations${date ? ` le ${date}` : ''}. Vous trouverez ci-dessous les étapes pour finaliser votre inscription, intégralement prise en charge par l'ANDPC.`,
    ouvert_sans_clic: `Je reviens vers vous suite à mon message${date ? ` du ${date}` : ''} concernant la formation « ${formation} ». Avez-vous pu avancer sur votre inscription ? Si une étape vous pose difficulté, je peux vous guider par téléphone.`,
    clique: `Je reviens vers vous suite à mon message${date ? ` du ${date}` : ''} concernant la formation « ${formation} ». Si votre inscription n'est pas encore finalisée, je reste à votre disposition pour vous accompagner.`,
  }
  const parts = [greeting, '', intro[relanceStatus(entry)], '', 'Bien cordialement,', senderName]
  if (body) parts.push('', '----- Mon précédent message -----', '', body.trim())
  return parts.join('\n')
}

// Relance rédigée par Claude : une seule génération par mail d'origine. Le brouillon est gardé
// (relance_draft:{id}, purgé avec l'envoi) et renvoyé à toute demande suivante, sans appel à Claude.
export interface StoredRelance {
  corps: string
  generated_at: string
  generated_by: string
}

export async function storedRelance(id: string): Promise<StoredRelance | null> {
  const d = await getKv().get<StoredRelance>(KEYS.relanceDraft(id))
  return d && typeof d.corps === 'string' && d.corps ? d : null
}
