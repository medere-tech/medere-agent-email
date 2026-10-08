import { NextRequest, NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { getKv, kvConfigured } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { CONTACT_HISTORY_DAYS } from '@/lib/config'
import { prefetchFormationsDejaFaites } from '@/lib/airtable'

export const dynamic = 'force-dynamic'

// Vocabulaire validé (mêmes libellés que /suivi)
const STATUT_LABEL: Record<string, string> = {
  envoyé: 'Envoyé',
  délivré: 'Reçu',
  ouvert: 'Ouvert',
  cliqué: 'Cliqué',
  bounce: 'Adresse invalide',
  plainte: 'Indésirable',
}

// « Déjà contacté » : envois (mails et relances) au même contact HubSpot sur les
// CONTACT_HISTORY_DAYS derniers jours, tous commerciaux confondus, du plus récent au plus ancien.
// POST (corps JSON { contactId, email, rpps }) : l'email du PS n'apparaît jamais dans l'adresse
// de la requête, donc jamais dans les journaux d'accès (Vercel).
export async function POST(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response
  const body = await req.json().catch(() => ({}))
  const contactId = String(body?.contactId || '')
  // Le contact vient d'être choisi : on pré-calcule ses formations déjà suivies (formations proposées
  // en fin de mail), sans attendre, pour que la rédaction démarre sans requête Airtable
  prefetchFormationsDejaFaites(String(body?.rpps || ''), String(body?.email || ''))
  if (!/^\d{1,20}$/.test(contactId) || !kvConfigured()) {
    return NextResponse.json({ jours: CONTACT_HISTORY_DAYS, envois: [] }, { headers: { 'Cache-Control': 'no-store' } })
  }
  try {
    const kv = getKv()
    const since = Date.now() - CONTACT_HISTORY_DAYS * 86400000
    const ids = (await kv.zrange(KEYS.byContact(contactId), '+inf', since, { byScore: true, rev: true, offset: 0, count: 20 })) as string[]
    const entries = ids.length ? await kv.mget<(Record<string, any> | null)[]>(...ids.map((id) => KEYS.track(id))) : []
    const envois = entries
      .filter((e): e is Record<string, any> => !!e)
      .map((e) => ({
        relance: e.kind === 'relance',
        commercial: e.commercial_name || e.commercial_email || 'Commercial inconnu',
        envoyeLe: e.sent_at || '',
        formation: e.formation_nom || '',
        statut: STATUT_LABEL[e.statut] || 'Envoyé',
      }))
    return NextResponse.json({ jours: CONTACT_HISTORY_DAYS, envois }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    console.error('[CONTACT-HISTORY] Lecture impossible :', e.message)
    return NextResponse.json({ error: 'Historique des envois indisponible.' }, { status: 503 })
  }
}
