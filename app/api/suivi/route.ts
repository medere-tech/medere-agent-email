import { NextRequest, NextResponse } from 'next/server'
import { getKv, kvConfigured } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { isMigrated, parisDay, statsFromCounters, statsFromEntries, type Stats } from '@/lib/tracking'
import { requireActor } from '@/lib/identity'
import { relanceVerdict } from '@/lib/relance'

// Lecture du KV à chaque appel : jamais de rendu statique au build, jamais de réponse
// gardée en cache par le navigateur (sinon "Actualiser" peut réafficher d'anciens chiffres)
export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest) {
  // Tout utilisateur connecté (lecteur compris) voit le suivi ; un compte « Plus actif » est refusé
  const guard = await requireActor({ readOnly: true })
  if (!guard.ok) return guard.response
  try {
    if (!kvConfigured()) {
      return NextResponse.json({ error: "Le suivi est momentanément indisponible. Réessaie dans quelques instants." }, { status: 500 })
    }

    const kv = getKv()
    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const limit = 20

    const total = await kv.zcard(KEYS.emailsIndex)
    if (total === 0) {
      return NextResponse.json({
        emails: [],
        total: 0,
        page: 1,
        pages: 0,
        stats: { total: 0, ouverts: 0, cliques: 0 },
      }, { headers: NO_STORE })
    }

    // Stats depuis le premier envoi : somme des compteurs journaliers une fois la base
    // migrée (scripts/migrate-kv.ts) ; avant, calculées sur les entrées elles-mêmes.
    let counts: Stats
    if (await isMigrated()) {
      const first = (await kv.zrange(KEYS.emailsIndex, 0, 0, { withScores: true })) as (string | number)[]
      const fromDay = parisDay(Number(first[1]))
      counts = await statsFromCounters(fromDay, parisDay())
    } else {
      const allIds = (await kv.zrange(KEYS.emailsIndex, 0, -1)) as string[]
      counts = statsFromEntries(await mgetEntries(allIds))
    }

    const stats = {
      total: counts.sent,
      ouverts: counts.opened,
      cliques: counts.clicked,
      delivres: counts.delivered,
      bounces: counts.bounced,
      plaintes: counts.complained,
    }

    // Données complètes pour la page courante uniquement
    const start = (page - 1) * limit
    const pageIds = (await kv.zrange(KEYS.emailsIndex, start, start + limit - 1, { rev: true })) as string[]
    const pageEntries = await mgetEntries(pageIds, true)
    // Relance rattachée à chaque mail, et droit de relancer pour la personne connectée
    const relanceIds = pageEntries.map((e) => e?.relance_id).filter((x): x is string => !!x)
    const relances = relanceIds.length ? await mgetEntries(relanceIds, true) : []
    const relanceById = new Map(relanceIds.map((id, i) => [id, relances[i]]))
    const emails = pageIds
      .map((id, i) => {
        const e = pageEntries[i]
        if (!e) return null
        const child = e.relance_id ? relanceById.get(e.relance_id) : null
        const verdict = relanceVerdict(guard.actor, e)
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
      })
      .filter(Boolean)

    return NextResponse.json({
      emails,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats,
    }, { headers: NO_STORE })
  } catch (e: any) {
    console.error('[SUIVI] Erreur:', e.message)
    return NextResponse.json({ error: "Le suivi est momentanément indisponible. Réessaie dans quelques instants." }, { status: 500 })
  }
}

// MGET par paquets de 500 ; keepNulls garde l'alignement avec la liste d'ids
async function mgetEntries(ids: string[], keepNulls = false): Promise<Record<string, any>[]> {
  const kv = getKv()
  const out: (Record<string, any> | null)[] = []
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    out.push(...(await kv.mget<(Record<string, any> | null)[]>(...chunk.map((id) => KEYS.track(id)))))
  }
  return (keepNulls ? out : out.filter(Boolean)) as Record<string, any>[]
}
