import { NextRequest, NextResponse } from 'next/server'
import { getKv, kvConfigured } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { requireActor } from '@/lib/identity'
import { isMigrated } from '@/lib/tracking'
import { parseFilters, runLegacyQuery, runQuery } from '@/lib/suivi-query'

export const dynamic = 'force-dynamic'

// Export CSV de la vue filtrée de /suivi (POST, mêmes filtres que /api/suivi, sans pagination).
// UTF-8 avec BOM et séparateur « ; » : s'ouvre directement dans Excel en français.
const STATUT_LABEL: Record<string, string> = {
  envoyé: 'Envoyé', délivré: 'Reçu', ouvert: 'Ouvert', cliqué: 'Cliqué', bounce: 'Adresse invalide', plainte: 'Indésirable',
}
const COLUMNS = [
  "Date d'envoi", 'Commercial', 'Envoyé par', 'Professionnel de santé', 'Email', 'Formation', 'Numéro DPC',
  'Statut', 'Ouvert le', 'Cliqué le', 'Relance envoyée le', 'Statut de la relance', 'Objet',
]

function frDate(iso: unknown): string {
  if (!iso || typeof iso !== 'string') return ''
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
  } catch { return '' }
}

function cell(v: unknown): string {
  let s = String(v ?? '').replace(/\r?\n/g, ' ')
  // Protection contre l'injection de formules dans Excel
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function POST(req: NextRequest) {
  const guard = await requireActor({ readOnly: true })
  if (!guard.ok) return guard.response
  if (!kvConfigured()) return NextResponse.json({ error: "L'export est momentanément indisponible." }, { status: 500 })
  try {
    const f = parseFilters(await req.json().catch(() => ({})), guard.actor)
    // Base pas encore migrée : même calcul de secours que /api/suivi
    const { ids } = (await isMigrated())
      ? await runQuery(f, { offset: 0, count: -1, entries: false, facets: false })
      : await runLegacyQuery(f, guard.actor, { offset: 0, count: -1, facets: false })
    const kv = getKv()
    const entries: (Record<string, any> | null)[] = []
    for (let i = 0; i < ids.length; i += 500) {
      entries.push(...(await kv.mget<(Record<string, any> | null)[]>(...ids.slice(i, i + 500).map((id) => KEYS.track(id)))))
    }
    const childIds = entries.map((e) => e?.relance_id).filter((x): x is string => !!x)
    const children = new Map<string, Record<string, any> | null>()
    for (let i = 0; i < childIds.length; i += 500) {
      const chunk = childIds.slice(i, i + 500)
      const got = await kv.mget<(Record<string, any> | null)[]>(...chunk.map((id) => KEYS.track(id)))
      chunk.forEach((id, j) => children.set(id, got[j]))
    }
    const lines = [COLUMNS.map(cell).join(';')]
    for (const e of entries) {
      if (!e) continue
      const c = e.relance_id ? children.get(e.relance_id) : null
      lines.push([
        frDate(e.sent_at), e.commercial_name, e.sent_by_name || '', e.ps_nom, e.ps_email, e.formation_nom, e.formation_numero || '',
        STATUT_LABEL[e.statut] || 'Envoyé', frDate(e.first_opened_at || e.opened_at), frDate(e.first_clicked_at || e.clicked_at),
        c ? frDate(c.sent_at) : '', c ? (STATUT_LABEL[c.statut] || 'Envoyé') : '', e.sujet,
      ].map(cell).join(';'))
    }
    const body = '﻿' + lines.join('\r\n') + '\r\n'
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="suivi-${f.from}-au-${f.to}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    console.error('[SUIVI] Export impossible :', e.message)
    return NextResponse.json({ error: "L'export est momentanément indisponible." }, { status: 500 })
  }
}
