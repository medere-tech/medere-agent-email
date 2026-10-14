import { NextRequest, NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { RELANCE_STATUS_LABEL, checkRelance, draftAJour, relanceDraft, relanceSessions, relanceStatus, relanceSubject, storedRelance } from '@/lib/relance'

export const dynamic = 'force-dynamic'

// Brouillon de relance d'un mail (objet, texte pré-rempli, statut). Mêmes contrôles que l'envoi.
// Sessions relues dans Airtable (lib/relance, relanceSessions) : mode et message affichés au commercial ;
// mode « aucune » → rédaction et envoi désactivés. Si Claude a déjà rédigé la relance de ce mail et que
// ses sessions sont toujours celles du jour, son texte est repris (une seule rédaction par mail).
export async function GET(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response
  const id = req.nextUrl.searchParams.get('id') || ''
  try {
    const check = await checkRelance(guard.actor, id)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
    const { entry, sender, sentBy } = check
    const [rs, stored] = await Promise.all([relanceSessions(id, entry), storedRelance(id)])
    const redigee = stored && draftAJour(stored, rs) ? stored : null
    if (stored && !redigee) console.log('[RELANCE] Brouillon enregistré obsolète (sessions changées), ignoré :', id)
    return NextResponse.json({
      id,
      sujet: relanceSubject(entry),
      corps: redigee ? redigee.corps : relanceDraft(entry, rs, sender),
      redigee: !!redigee,
      mode: rs.mode,
      message: rs.message,
      possible: rs.mode !== 'aucune',
      aujourdhui: rs.today,
      statut: RELANCE_STATUS_LABEL[relanceStatus(entry)],
      ps: { nom: entry.ps_nom, email: entry.ps_email },
      formation: entry.formation_nom,
      envoyeLe: entry.sent_at,
      commercial: sender.name,
      auNomDe: sentBy ? sender.name : null,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    console.error('[RELANCE] Préparation impossible :', e.message)
    return NextResponse.json({ error: 'Impossible de préparer la relance. Réessaie dans quelques instants.' }, { status: 500 })
  }
}
