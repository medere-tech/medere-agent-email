import { NextRequest, NextResponse } from 'next/server'
import { requireActor } from '@/lib/identity'
import { RELANCE_STATUS_LABEL, checkRelance, originalBody, relanceDraft, relanceStatus, relanceSubject, storedRelance } from '@/lib/relance'

export const dynamic = 'force-dynamic'

// Brouillon de relance d'un mail (objet, texte pré-rempli, statut). Mêmes contrôles que l'envoi.
// Si Claude a déjà rédigé la relance de ce mail, son texte est repris (une seule rédaction par mail).
export async function GET(req: NextRequest) {
  const guard = await requireActor()
  if (!guard.ok) return guard.response
  const id = req.nextUrl.searchParams.get('id') || ''
  try {
    const check = await checkRelance(guard.actor, id)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
    const { entry, sender, sentBy } = check
    const [body, redigee] = await Promise.all([originalBody(id), storedRelance(id)])
    return NextResponse.json({
      id,
      sujet: relanceSubject(entry),
      corps: redigee ? redigee.corps : relanceDraft(entry, body, sender.name),
      redigeeParClaude: !!redigee,
      statut: RELANCE_STATUS_LABEL[relanceStatus(entry)],
      corpsOrigineManquant: !body,
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
