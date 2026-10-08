import { NextRequest, NextResponse } from 'next/server'
import { getKv, kvConfigured } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { requireActor } from '@/lib/identity'
import { relanceVerdict } from '@/lib/relance'
import { TRACKING_RELIABLE_SINCE } from '@/lib/config'
import { isMigrated } from '@/lib/tracking'
import { SUIVI_PAGE_SIZE, actorKey, countersFor, needsEntries, parseFilters, runLegacyQuery, runQuery, type SuiviStats } from '@/lib/suivi-query'

// Lecture du KV à chaque appel : jamais de rendu statique au build, jamais de réponse
// gardée en cache par le navigateur (sinon "Actualiser" peut réafficher d'anciens chiffres)
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const KO = "Le suivi est momentanément indisponible. Réessaie dans quelques instants."

// POST /api/suivi, corps JSON { from, to, mine, commercial, statut, formation, q, page, facets? }
//   - liste paginée des mails (envois initiaux, relance rattachée sous chacun) de la vue filtrée ;
//   - indicateurs : équipe et personne connectée (compteurs journaliers de la période), et vue
//     filtrée (compteurs si seuls période et commercial sont filtrés, sinon calculés sur les lignes) ;
//   - facets=1 : formations présentes sur la période (liste du filtre « Formation »).
export async function POST(req: NextRequest) {
  // Tout utilisateur connecté (lecteur compris) voit le suivi ; un compte « Plus actif » est refusé
  const guard = await requireActor({ readOnly: true })
  if (!guard.ok) return guard.response
  const { actor } = guard
  if (!kvConfigured()) return NextResponse.json({ error: KO }, { status: 500 })
  try {
    const body = await req.json().catch(() => ({}))
    const f = parseFilters(body, actor)
    const own = actorKey(actor)
    const kv = getKv()
    // Base pas encore migrée (meta:schema_version ≠ 2) : calcul de secours sur les envois eux-mêmes
    const migrated = await isMigrated()

    if (body?.facets) {
      const r = !migrated
        ? await runLegacyQuery({ ...f, statut: '', formation: '', q: '' }, actor, { offset: 0, count: 0, facets: true })
        : await runQuery({ ...f, statut: '', formation: '', q: '' }, { offset: 0, count: 0, entries: false, facets: true })
      const formations = (r.formations || []).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
      return NextResponse.json({ formations }, { headers: NO_STORE })
    }

    const keys = Array.from(new Set([own, f.commercial].filter((k): k is string => !!k)))
    let result: Awaited<ReturnType<typeof runQuery>>
    let equipe: SuiviStats, perso: SuiviStats | null, vue: SuiviStats
    let commerciauxMap: Record<string, string>
    if (migrated) {
      const [r, counters, names] = await Promise.all([
        runQuery(f, { offset: (f.page - 1) * SUIVI_PAGE_SIZE, count: SUIVI_PAGE_SIZE, entries: true, facets: false }),
        countersFor(f.from, f.to, keys),
        kv.hgetall<Record<string, string>>(KEYS.commerciaux),
      ])
      result = r
      equipe = counters.team
      perso = own ? counters.byKey[own] : null
      vue = needsEntries(f) ? r.stats! : f.commercial ? counters.byKey[f.commercial] : counters.team
      commerciauxMap = names || {}
    } else {
      const r = await runLegacyQuery(f, actor, { offset: (f.page - 1) * SUIVI_PAGE_SIZE, count: SUIVI_PAGE_SIZE, facets: false })
      result = r
      equipe = r.equipe
      perso = r.perso
      vue = r.vue
      commerciauxMap = Object.fromEntries(r.commerciaux.map((c) => [c.key, c.name]))
    }

    const emails = result.ids.map((id, i) => {
      const e = result.entries[i]
      if (!e) return null
      const child = e.relance_id ? result.children[e.relance_id] : null
      const verdict = relanceVerdict(actor, e)
      return {
        resend_id: id,
        ...e,
        relance: child ? {
          resend_id: e.relance_id,
          statut: child.statut,
          sent_at: child.sent_at,
          opened_at: child.first_opened_at || child.opened_at || null,
          clicked_at: child.first_clicked_at || child.clicked_at || null,
          sent_by_name: child.sent_by_name || null,
        } : null,
        relance_possible: verdict.ok,
        relance_bloquee: verdict.ok ? null : verdict.error,
      }
    }).filter(Boolean)

    const commerciaux = Object.entries(commerciauxMap)
      .map(([key, name]) => ({ key, name: String(name || key) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))

    return NextResponse.json({
      emails,
      total: result.total,
      page: f.page,
      pages: Math.ceil(result.total / SUIVI_PAGE_SIZE),
      filtres: { from: f.from, to: f.to, mine: f.mine, commercial: f.commercial, statut: f.statut, formation: f.formation, q: f.q },
      stats: { equipe, perso, vue },
      migre: migrated,
      moi: { role: actor.role, key: own },
      commerciaux,
      trackingReliableSince: TRACKING_RELIABLE_SINCE,
    }, { headers: NO_STORE })
  } catch (e: any) {
    console.error('[SUIVI] Erreur:', e.message)
    return NextResponse.json({ error: KO }, { status: 500 })
  }
}
