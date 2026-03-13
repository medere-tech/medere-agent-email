import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  try {
    if (!process.env.KV_REST_API_URL) {
      return NextResponse.json({ error: 'KV non configuré' }, { status: 500 })
    }

    const { kv } = await import('@vercel/kv')
    const { searchParams } = new URL(req.url)
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const limit = 20

    // Récupérer TOUS les IDs pour les stats (sorted set complet)
    const allIds = await kv.zrange('emails_index', 0, -1, { rev: true }) as string[]
    const total = allIds.length

    if (total === 0) {
      return NextResponse.json({
        emails: [],
        total: 0,
        page: 1,
        pages: 0,
        stats: { total: 0, ouverts: 0, cliques: 0 },
      })
    }

    // Stats calculées sur TOUS les emails de l'index, pas un sous-ensemble arbitraire
    const allStatuts = await Promise.all(
      allIds.map(async (id) => {
        try {
          const d = await kv.get(`email_track:${id}`) as Record<string, any> | null
          return d?.statut ?? null
        } catch {
          return null
        }
      })
    )

    const stats = {
      total: allStatuts.filter(Boolean).length,
      ouverts: allStatuts.filter((s) => s === 'ouvert' || s === 'cliqué').length,
      cliques: allStatuts.filter((s) => s === 'cliqué').length,
    }

    // Pagination sur les IDs
    const start = (page - 1) * limit
    const pageIds = allIds.slice(start, start + limit)

    if (!pageIds.length) {
      return NextResponse.json({
        emails: [],
        total,
        page,
        pages: Math.ceil(total / limit),
        stats,
      })
    }

    // Données complètes pour la page courante uniquement
    const pageResults = await Promise.all(
      pageIds.map(async (id) => {
        try {
          const data = await kv.get(`email_track:${id}`) as Record<string, any> | null
          if (!data) return null
          return { resend_id: id, ...data }
        } catch {
          return null
        }
      })
    )

    const emails = pageResults.filter(Boolean)

    return NextResponse.json({
      emails,
      total,
      page,
      pages: Math.ceil(total / limit),
      stats,
    })
  } catch (e: any) {
    console.error('[SUIVI] Erreur:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}