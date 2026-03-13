'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'

interface EmailEntry {
  resend_id: string
  contact_id: string
  ps_nom: string
  ps_email: string
  commercial_name: string
  formation_nom: string
  sujet: string
  statut: 'envoyé' | 'ouvert' | 'cliqué'
  sent_at: string
  opened_at: string | null
  clicked_at: string | null
}

interface Stats {
  total: number
  ouverts: number
  cliques: number
}

interface ApiResponse {
  emails: EmailEntry[]
  total: number
  page: number
  pages: number
  stats: Stats
}

// ─── Icons (SVG only, no emoji) ───────────────────────────────────────────────
const Icons = {
  Mail: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M1.5 5.5L8 9.5L14.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  Eye: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 8C1.5 8 4 3.5 8 3.5C12 3.5 14.5 8 14.5 8C14.5 8 12 12.5 8 12.5C4 12.5 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.5"/>
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5"/>
    </svg>
  ),
  Click: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6 2V8.5L8.5 7L10 10.5L11.5 9.5L10 6H13L6 2Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
    </svg>
  ),
  Send: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M13.5 2.5L7 9M13.5 2.5L9.5 13.5L7 9M13.5 2.5L2.5 6.5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  Refresh: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M13.5 8A5.5 5.5 0 1 1 10 3.5L13.5 3.5V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  ChevronLeft: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  ChevronRight: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  ExternalLink: () => (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path d="M7 3H3C2.44772 3 2 3.44772 2 4V13C2 13.5523 2.44772 14 3 14H12C12.5523 14 13 13.5523 13 13V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M9 2H14V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M14 2L8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  Loader: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="animate-spin">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="10"/>
    </svg>
  ),
  Empty: () => (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
      <rect x="4" y="6" width="24" height="20" rx="3" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M4 12H28" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M10 18H16M10 22H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  ChevronDown: () => (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
}

// ─── Statut Badge — monochrome uniquement ─────────────────────────────────────
function StatutBadge({ statut }: { statut: EmailEntry['statut'] }) {
  const config: Record<string, { icon: React.ReactNode; label: string; cls: string }> = {
    envoyé:  { icon: <Icons.Send />,  label: 'Envoyé',  cls: 'bg-zinc-100 text-zinc-500' },
    ouvert:  { icon: <Icons.Eye />,   label: 'Ouvert',  cls: 'bg-zinc-900 text-white' },
    cliqué:  { icon: <Icons.Click />, label: 'Cliqué',  cls: 'bg-zinc-900 text-white' },
  }
  const c = config[statut] ?? config['envoyé']
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${c.cls}`}>
      {c.icon}
      {c.label}
    </span>
  )
}

// ─── Stat Card — monochrome ───────────────────────────────────────────────────
function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-white border border-zinc-200 rounded-lg p-4">
      <div className="text-xs font-medium text-zinc-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-zinc-900">{typeof value === 'number' ? value.toLocaleString('fr-FR') : value}</div>
      {sub && <div className="text-xs text-zinc-400 mt-0.5">{sub}</div>}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatRelative(iso: string) {
  if (!iso) return '—'
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 60) return `il y a ${mins}min`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `il y a ${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `il y a ${days}j`
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(iso))
  } catch { return '—' }
}

function formatFull(iso: string) {
  if (!iso) return '—'
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  } catch { return '—' }
}

function pct(num: number, den: number) {
  if (!den) return '0 %'
  return `${Math.round((num / den) * 100)} %`
}

// ─── Page principale ──────────────────────────────────────────────────────────
export default function SuiviPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const fetchData = useCallback(async (p: number, silent = false) => {
    silent ? setRefreshing(true) : setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/suivi?page=${p}`)
      if (!res.ok) throw new Error('Erreur serveur')
      setData(await res.json())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { fetchData(page) }, [page, fetchData])
  useEffect(() => {
    const t = setInterval(() => fetchData(page, true), 60000)
    return () => clearInterval(t)
  }, [page, fetchData])

  // Pages à afficher dans la pagination
  function pageNumbers(current: number, total: number): (number | '…')[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
    const left = Math.max(2, current - 1)
    const right = Math.min(total - 1, current + 1)
    const pages: (number | '…')[] = [1]
    if (left > 2) pages.push('…')
    for (let i = left; i <= right; i++) pages.push(i)
    if (right < total - 1) pages.push('…')
    pages.push(total)
    return pages
  }

  return (
    <div className="min-h-screen bg-zinc-50 py-8 px-4">
      <div className="w-full max-w-5xl mx-auto">

        {/* Header */}
        <div className="mb-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="3" width="8" height="18" rx="4" fill="#111111"/>
                <rect x="14" y="3" width="8" height="18" rx="4" fill="#111111"/>
              </svg>
              <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Médéré</span>
            </div>
            <h1 className="text-xl font-semibold text-zinc-900">Suivi des envois</h1>
            <p className="text-sm text-zinc-500 mt-0.5">Historique complet des mails DPC</p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="px-3 py-2 border border-zinc-200 text-xs font-medium text-zinc-600 rounded-lg hover:bg-white transition-colors"
            >
              ← Agent Mail
            </Link>
            <button
              onClick={() => fetchData(page, true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-2 border border-zinc-200 text-xs font-medium text-zinc-600 rounded-lg hover:bg-white transition-colors disabled:opacity-40"
            >
              <span className={refreshing ? 'animate-spin inline-flex' : 'inline-flex'}>
                <Icons.Refresh />
              </span>
              {refreshing ? 'Actualisation…' : 'Actualiser'}
            </button>
          </div>
        </div>

        {/* Stats — calculées sur la totalité de l'index */}
        {data && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <StatCard
              label="Mails envoyés"
              value={data.stats.total}
              sub="depuis le début"
            />
            <StatCard
              label="Taux d'ouverture"
              value={pct(data.stats.ouverts, data.stats.total)}
              sub={`${data.stats.ouverts.toLocaleString('fr-FR')} ouvert${data.stats.ouverts > 1 ? 's' : ''}`}
            />
            <StatCard
              label="Taux de clic"
              value={pct(data.stats.cliques, data.stats.total)}
              sub={`${data.stats.cliques.toLocaleString('fr-FR')} cliqué${data.stats.cliques > 1 ? 's' : ''}`}
            />
          </div>
        )}

        {/* Tableau */}
        <div className="bg-white border border-zinc-200 rounded-xl shadow-sm overflow-hidden">

          {loading && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-zinc-400">
              <Icons.Loader />
              <span className="text-sm">Chargement…</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-24 gap-2 text-zinc-500">
              <span className="text-sm">Erreur : {error}</span>
              <button onClick={() => fetchData(page)} className="text-xs text-zinc-400 underline">
                Réessayer
              </button>
            </div>
          )}

          {!loading && !error && data?.emails.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-zinc-400">
              <Icons.Empty />
              <div className="text-center">
                <p className="text-sm font-medium text-zinc-600">Aucun email envoyé pour l'instant</p>
                <p className="text-xs text-zinc-400 mt-0.5">Les mails envoyés via l'Agent Mail apparaîtront ici</p>
              </div>
            </div>
          )}

          {!loading && !error && data && data.emails.length > 0 && (
            <>
              <div className="overflow-x-auto -mx-0 sm:mx-0">
                <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '22%' }} />
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '26%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '14%' }} />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-zinc-100">
                      <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Professionnel de santé</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Commercial</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Formation</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Statut</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Envoyé</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.emails.map((email) => {
                      const isExpanded = expanded === email.resend_id
                      return (
                        <>
                          <tr
                            key={email.resend_id}
                            onClick={() => setExpanded(isExpanded ? null : email.resend_id)}
                            className={`border-b border-zinc-50 cursor-pointer transition-colors ${
                              isExpanded ? 'bg-zinc-50' : 'hover:bg-zinc-50'
                            }`}
                          >
                            <td className="px-4 py-3">
                              <div className="font-medium text-zinc-900 truncate text-sm" title={email.ps_nom}>{email.ps_nom}</div>
                              <div className="text-xs text-zinc-400 truncate" title={email.ps_email}>{email.ps_email}</div>
                            </td>
                            <td className="px-4 py-3 text-xs text-zinc-700 truncate">
                              {email.commercial_name.split(' ')[0]}
                            </td>
                            <td className="px-4 py-3">
                              <div className="text-xs text-zinc-700 leading-snug line-clamp-2" title={email.formation_nom}>
                                {email.formation_nom}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <StatutBadge statut={email.statut} />
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-xs text-zinc-500" title={formatFull(email.sent_at)}>
                                {formatRelative(email.sent_at)}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-end gap-3">
                                {email.contact_id && (
                                  <a
                                    href={`https://app-eu1.hubspot.com/contacts/26228968/contacts/${email.contact_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors inline-flex items-center gap-1"
                                  >
                                    HubSpot <Icons.ExternalLink />
                                  </a>
                                )}
                                <span className={`text-zinc-400 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}>
                                  <Icons.ChevronDown />
                                </span>
                              </div>
                            </td>
                          </tr>

                          {isExpanded && (
                            <tr key={`${email.resend_id}-exp`} className="bg-zinc-50 border-b border-zinc-100">
                              <td colSpan={6} className="px-4 py-3">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                                  <div>
                                    <div className="text-zinc-400 mb-1.5 font-medium">Sujet</div>
                                    <div className="text-zinc-700">{email.sujet}</div>
                                  </div>
                                  <div>
                                    <div className="text-zinc-400 mb-1.5 font-medium">Événements</div>
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-2 text-zinc-600">
                                        <Icons.Send />
                                        <span>Envoyé le {formatFull(email.sent_at)}</span>
                                      </div>
                                      {email.opened_at ? (
                                        <div className="flex items-center gap-2 text-zinc-800">
                                          <Icons.Eye />
                                          <span>Ouvert le {formatFull(email.opened_at)}</span>
                                        </div>
                                      ) : (
                                        <div className="flex items-center gap-2 text-zinc-300">
                                          <Icons.Eye />
                                          <span>Pas encore ouvert</span>
                                        </div>
                                      )}
                                      {email.clicked_at ? (
                                        <div className="flex items-center gap-2 text-zinc-800">
                                          <Icons.Click />
                                          <span>Cliqué le {formatFull(email.clicked_at)}</span>
                                        </div>
                                      ) : (
                                        <div className="flex items-center gap-2 text-zinc-300">
                                          <Icons.Click />
                                          <span>Pas encore cliqué</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-zinc-400 mb-1.5 font-medium">ID Resend</div>
                                    <div className="font-mono text-zinc-400 text-[10px] break-all">{email.resend_id}</div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {data.pages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-100">
                  <span className="text-xs text-zinc-400">
                    {((page - 1) * 20) + 1}–{Math.min(page * 20, data.total)} sur {data.total.toLocaleString('fr-FR')} mails
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 text-xs rounded-lg hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Icons.ChevronLeft /> Préc.
                    </button>
                    <div className="flex items-center gap-0.5 px-1">
                      {pageNumbers(page, data.pages).map((p, i) =>
                        p === '…' ? (
                          <span key={`e${i}`} className="w-7 h-7 flex items-center justify-center text-xs text-zinc-400">…</span>
                        ) : (
                          <button
                            key={p}
                            onClick={() => setPage(p as number)}
                            className={`w-7 h-7 text-xs rounded-md transition-colors ${
                              page === p
                                ? 'bg-zinc-900 text-white font-medium'
                                : 'hover:bg-zinc-100 text-zinc-600'
                            }`}
                          >
                            {p}
                          </button>
                        )
                      )}
                    </div>
                    <button
                      onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
                      disabled={page === data.pages}
                      className="flex items-center gap-1 px-2.5 py-1.5 border border-zinc-200 text-xs rounded-lg hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Suiv. <Icons.ChevronRight />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-4 text-center text-xs text-zinc-400">
          Actualisation automatique toutes les 60s ·{' '}
          <button className="hover:underline" onClick={() => fetchData(page, true)}>
            Forcer l'actualisation
          </button>
        </div>

      </div>
    </div>
  )
}