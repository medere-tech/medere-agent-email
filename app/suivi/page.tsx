'use client'

import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import Link from 'next/link'
import RelancePanel from '@/components/RelancePanel'

interface EmailEntry {
  resend_id: string
  contact_id: string
  ps_nom: string
  ps_email: string
  commercial_name: string
  sent_by_name?: string
  formation_nom: string
  sujet: string
  statut: 'envoyé' | 'délivré' | 'ouvert' | 'cliqué' | 'bounce' | 'plainte'
  sent_at: string
  opened_at: string | null
  clicked_at: string | null
  first_opened_at?: string | null
  first_clicked_at?: string | null
  open_count?: number
  click_count?: number
  // Relance par mail rattachée à ce mail (null s'il n'y en a pas)
  relance?: { resend_id: string; statut: EmailEntry['statut']; sent_at: string; opened_at: string | null; clicked_at: string | null; sent_by_name: string | null } | null
  // Relance possible pour la personne connectée ; sinon, la raison
  relance_possible?: boolean
  relance_bloquee?: string | null
}

interface Stats { sent: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number }

interface Filtres { from: string; to: string; mine: boolean; commercial: string; statut: string; formation: string; q: string }

interface ApiResponse {
  emails: EmailEntry[]
  total: number
  page: number
  pages: number
  filtres: Filtres
  stats: { equipe: Stats; perso: Stats | null; vue: Stats }
  moi: { role: 'admin' | 'commercial' | 'lecteur'; key: string | null }
  commerciaux: { key: string; name: string }[]
  trackingReliableSince: string | null
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
  Delivered: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 8.5L5 11.5L10 5.5M8 11.5L14 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  Alert: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M8 7V9.5M8 11.5V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  Logout: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6 2.5H3.5C2.95 2.5 2.5 2.95 2.5 3.5V12.5C2.5 13.05 2.95 13.5 3.5 13.5H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M10.5 11L13.5 8L10.5 5M13.5 8H6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  Search: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  Download: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2.5V10M8 10L5 7M8 10L11 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M2.5 11V12.5C2.5 13.05 2.95 13.5 3.5 13.5H12.5C13.05 13.5 13.5 13.05 13.5 12.5V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
}

// ─── Statut Badge — monochrome uniquement ─────────────────────────────────────
function StatutBadge({ statut }: { statut: EmailEntry['statut'] }) {
  const config: Record<string, { icon: React.ReactNode; label: string; cls: string }> = {
    envoyé:  { icon: <Icons.Send />,  label: 'Envoyé',  cls: 'bg-zinc-100 text-zinc-500' },
    délivré: { icon: <Icons.Delivered />, label: 'Reçu', cls: 'bg-zinc-100 text-zinc-700' },
    ouvert:  { icon: <Icons.Eye />,   label: 'Ouvert',  cls: 'bg-zinc-900 text-white' },
    cliqué:  { icon: <Icons.Click />, label: 'Cliqué', cls: 'bg-zinc-900 text-white' },
    bounce:  { icon: <Icons.Alert />, label: 'Adresse invalide', cls: 'border border-zinc-400 text-zinc-700' },
    plainte: { icon: <Icons.Alert />, label: 'Indésirable', cls: 'border border-zinc-400 text-zinc-700' },
  }
  const c = config[statut] ?? config['envoyé']
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${c.cls}`}>
      {c.icon}
      {c.label}
    </span>
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

function abrevTitre(nom: string) {
  return nom
    .replace(/^Docteur\s/i, 'Dr ')
    .replace(/^Madame\s/i, 'Mme ')
    .replace(/^Monsieur\s/i, 'M. ')
}

const SUIVI_KO = "Impossible d'afficher le suivi. Réessaie dans quelques instants."

// ─── Période (jours calendaires, heure de Paris) ─────────────────────────────
type Preset = 'today' | '7' | '30' | 'month' | 'lastMonth' | 'custom'
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: "Aujourd'hui" },
  { id: '7', label: '7 jours' },
  { id: '30', label: '30 jours' },
  { id: 'month', label: 'Ce mois' },
  { id: 'lastMonth', label: 'Mois dernier' },
  { id: 'custom', label: 'Personnalisée' },
]

function parisToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function periodOf(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const today = parisToday()
  if (preset === 'today') return { from: today, to: today }
  if (preset === '7') return { from: addDays(today, -6), to: today }
  if (preset === '30') return { from: addDays(today, -29), to: today }
  if (preset === 'month') return { from: `${today.slice(0, 8)}01`, to: today }
  if (preset === 'lastMonth') {
    const firstThis = `${today.slice(0, 8)}01`
    const lastPrev = addDays(firstThis, -1)
    return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev }
  }
  return custom.from && custom.to ? (custom.from <= custom.to ? custom : { from: custom.to, to: custom.from }) : { from: addDays(today, -29), to: today }
}
function frDay(day: string): string {
  const [y, m, d] = day.split('-')
  return `${d}/${m}/${y}`
}

const STATUT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Tous les statuts' },
  { value: 'envoyé', label: 'Envoyé' },
  { value: 'délivré', label: 'Reçu' },
  { value: 'ouvert', label: 'Ouvert' },
  { value: 'cliqué', label: 'Cliqué' },
  { value: 'bounce', label: 'Adresse invalide' },
  { value: 'plainte', label: 'Indésirable' },
]

const selectCls = 'h-9 px-2.5 border border-zinc-200 rounded-lg text-xs text-zinc-700 bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900/10 disabled:opacity-40 disabled:cursor-not-allowed min-w-0'

// Bloc d'indicateurs (équipe ou personne connectée)
function StatsPanel({ title, stats }: { title: string; stats: Stats }) {
  return (
    <div className="bg-white border border-zinc-200 rounded-lg p-4" data-panel={title}>
      <div className="text-xs font-semibold text-zinc-900 mb-3">{title}</div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[11px] font-medium text-zinc-500">Mails envoyés</div>
          <div className="text-xl font-semibold text-zinc-900">{stats.sent.toLocaleString('fr-FR')}</div>
          <div className="text-[11px] text-zinc-400">{stats.delivered.toLocaleString('fr-FR')} reçu{stats.delivered > 1 ? 's' : ''}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium text-zinc-500">Taux d'ouverture</div>
          <div className="text-xl font-semibold text-zinc-900">{pct(stats.opened, stats.sent)}</div>
          <div className="text-[11px] text-zinc-400">{stats.opened.toLocaleString('fr-FR')} ouvert{stats.opened > 1 ? 's' : ''}</div>
        </div>
        <div>
          <div className="text-[11px] font-medium text-zinc-500">Taux de clic</div>
          <div className="text-xl font-semibold text-zinc-900">{pct(stats.clicked, stats.sent)}</div>
          <div className="text-[11px] text-zinc-400">{stats.clicked.toLocaleString('fr-FR')} cliqué{stats.clicked > 1 ? 's' : ''}</div>
        </div>
      </div>
    </div>
  )
}

// ─── Page principale ──────────────────────────────────────────────────────────
export default function SuiviPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  // Filtres. « Mes envois » : null tant que le serveur n'a pas donné la valeur par défaut du rôle
  const [preset, setPreset] = useState<Preset>('30')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [mine, setMine] = useState<boolean | null>(null)
  const [commercial, setCommercial] = useState('')
  const [statut, setStatut] = useState('')
  const [formation, setFormation] = useState('')
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [formations, setFormations] = useState<{ key: string; nom: string; count: number }[]>([])
  // Colonnes visibles du tableau (3 sur mobile, 6 à partir de 640 px) : la ligne de détail les couvre exactement
  const [visibleCols, setVisibleCols] = useState(6)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    const update = () => setVisibleCols(mq.matches ? 6 : 3)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Fenêtre de relance ouverte (identifiant du mail d'origine) ; ?relance=… l'ouvre directement (lien du DM Slack)
  const [relanceId, setRelanceId] = useState<string | null>(null)
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('relance')
    if (fromUrl) setRelanceId(fromUrl)
  }, [])
  const closeRelance = () => {
    setRelanceId(null)
    const url = new URL(window.location.href)
    if (url.searchParams.has('relance')) { url.searchParams.delete('relance'); window.history.replaceState(null, '', url.toString()) }
  }

  // Recherche : appliquée 250 ms après la dernière frappe
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 250)
    return () => clearTimeout(t)
  }, [qInput])

  const period = useMemo(() => periodOf(preset, custom), [preset, custom])
  const body = useMemo(() => ({
    from: period.from, to: period.to,
    ...(mine === null ? {} : { mine: mine ? '1' : '0' }),
    commercial: mine ? '' : commercial, statut, formation, q, page,
  }), [period, mine, commercial, statut, formation, q, page])
  const bodyKey = JSON.stringify(body)

  // Réponses déjà reçues (retour instantané sur une vue déjà vue, puis actualisation silencieuse)
  const cacheRef = useRef(new Map<string, ApiResponse>())
  const abortRef = useRef<AbortController | null>(null)
  const hasDataRef = useRef(false)
  // Requête dont la réponse est affichée (repère de mesure : data-vue / data-etat sur le tableau)
  const [shownKey, setShownKey] = useState('')

  const fetchData = useCallback(async (silent = false) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const cached = cacheRef.current.get(bodyKey)
    if (cached) { setData(cached); setShownKey(bodyKey); setLoading(false) }
    // Liste déjà affichée : elle reste visible (« Mise à jour… ») pendant la requête, sans saut de page
    if (silent || cached || hasDataRef.current) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/suivi', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyKey, cache: 'no-store', signal: ctrl.signal,
      })
      if (!res.ok) {
        // Accès refusé (compte désactivé) ou session expirée : message du serveur, déjà lisible
        const b = await res.json().catch(() => null)
        throw Object.assign(new Error((res.status === 401 || res.status === 403) && b?.error ? b.error : SUIVI_KO), { userFacing: true })
      }
      const d: ApiResponse = await res.json()
      if (ctrl.signal.aborted) return
      cacheRef.current.set(bodyKey, d)
      hasDataRef.current = true
      setData(d)
      setShownKey(bodyKey)
      if (mine === null) {
        // Valeur par défaut de « Mes envois » donnée par le serveur : la même réponse sert pour la vue suivante
        const sent = JSON.parse(bodyKey)
        cacheRef.current.set(JSON.stringify({ from: sent.from, to: sent.to, mine: d.filtres.mine ? '1' : '0', commercial: d.filtres.mine ? '' : sent.commercial, statut: sent.statut, formation: sent.formation, q: sent.q, page: sent.page }), d)
        setMine(d.filtres.mine)
      }
    } catch (e: any) {
      if (ctrl.signal.aborted) return
      // Seuls les messages préparés pour l'utilisateur sont affichés (pas « Failed to fetch »)
      setError(e?.userFacing ? e.message : SUIVI_KO)
    } finally {
      if (abortRef.current === ctrl) { setLoading(false); setRefreshing(false) }
    }
  }, [bodyKey, mine])

  useEffect(() => { fetchData() }, [fetchData])

  // Préchargement des autres périodes (mêmes filtres, page 1) dès le premier affichage : passer
  // d'une période à l'autre est alors instantané (puis actualisé en arrière-plan)
  const prefetchedRef = useRef(new Set<string>())
  useEffect(() => {
    if (mine === null || !data) return
    for (const p of PRESETS) {
      if (p.id === 'custom' || p.id === preset) continue
      const per = periodOf(p.id, custom)
      const b = JSON.stringify({ from: per.from, to: per.to, mine: mine ? '1' : '0', commercial: mine ? '' : commercial, statut, formation, q, page: 1 })
      if (cacheRef.current.has(b) || prefetchedRef.current.has(b)) continue
      prefetchedRef.current.add(b)
      fetch('/api/suivi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) cacheRef.current.set(b, d) })
        .catch(() => {})
        .finally(() => prefetchedRef.current.delete(b))
    }
  }, [data, mine, commercial, statut, formation, q, preset, custom])

  // Formations présentes sur la période (liste du filtre), chargées sans bloquer la liste
  useEffect(() => {
    if (mine === null) return
    let alive = true
    fetch('/api/suivi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ from: period.from, to: period.to, mine: mine ? '1' : '0', commercial: mine ? '' : commercial, facets: 1 }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.formations) setFormations(d.formations) })
      .catch(() => {})
    return () => { alive = false }
  }, [period, mine, commercial])

  // Actualisation automatique toutes les minutes, coupée quand l'onglet est caché ;
  // au retour sur l'onglet, une actualisation immédiate
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => { if (!timer) timer = setInterval(() => fetchData(true), 60000) }
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { fetchData(true); start() } else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [fetchData])

  // Tout changement de filtre ramène à la première page
  const change = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(1); setExpanded(null) }

  const exportCsv = async () => {
    setExporting(true)
    setExportError('')
    try {
      const res = await fetch('/api/suivi/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, page: 1 }) })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `suivi-${period.from}-au-${period.to}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setExportError("L'export a échoué. Réessaie dans quelques instants.")
    } finally {
      setExporting(false)
    }
  }

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

  const filtered = !!(statut || formation || q || (!mine && commercial))
  const since = data?.trackingReliableSince
  const showReliability = !!since && period.from < since
  const canBeMine = !!data?.moi.key

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
            <p className="text-sm text-zinc-500 mt-0.5">Mails DPC du {frDay(period.from)} au {frDay(period.to)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/"
              className="px-3 py-2 border border-zinc-200 text-xs font-medium text-zinc-600 rounded-lg hover:bg-white transition-colors"
            >
              ← Agent Mail
            </Link>
            <button
              onClick={() => fetchData(true)}
              disabled={refreshing}
              className="flex items-center gap-1.5 px-3 py-2 border border-zinc-200 text-xs font-medium text-zinc-600 rounded-lg hover:bg-white transition-colors disabled:opacity-40"
            >
              <span className={refreshing ? 'animate-spin inline-flex' : 'inline-flex'}>
                <Icons.Refresh />
              </span>
              {refreshing ? 'Actualisation…' : 'Actualiser'}
            </button>
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                className="flex items-center gap-1.5 px-3 py-2 border border-zinc-200 text-xs font-medium text-zinc-600 rounded-lg hover:bg-white transition-colors"
              >
                <Icons.Logout />
                Se déconnecter
              </button>
            </form>
          </div>
        </div>

        {/* Période */}
        <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2" data-zone="periode">
          <div className="flex flex-wrap gap-1 p-1 bg-white border border-zinc-200 rounded-lg" role="tablist" aria-label="Période">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={preset === p.id}
                onClick={() => {
                  if (p.id === 'custom' && !custom.from) setCustom(periodOf(preset, custom))
                  change(setPreset)(p.id)
                }}
                className={`px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                  preset === p.id ? 'bg-zinc-900 text-white font-medium' : 'text-zinc-600 hover:bg-zinc-100'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <label className="flex items-center gap-1.5">Du
                <input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => change(setCustom)({ ...custom, from: e.target.value })} className={selectCls} />
              </label>
              <label className="flex items-center gap-1.5">au
                <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => change(setCustom)({ ...custom, to: e.target.value })} className={selectCls} />
              </label>
            </div>
          )}
        </div>

        {/* Filtres */}
        <div className="mb-5 flex flex-wrap items-center gap-2" data-zone="filtres">
          {canBeMine && (
            <button
              type="button"
              role="switch"
              aria-checked={!!mine}
              onClick={() => change(setMine)(!mine)}
              className="flex items-center gap-2 h-9 px-3 border border-zinc-200 rounded-lg bg-white text-xs font-medium text-zinc-700 hover:border-zinc-300 w-full sm:w-auto"
            >
              <span className={`relative inline-flex w-7 h-4 rounded-full transition-colors ${mine ? 'bg-zinc-900' : 'bg-zinc-200'}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${mine ? 'left-3.5' : 'left-0.5'}`} />
              </span>
              Mes envois
            </button>
          )}
          <select aria-label="Commercial" value={mine ? '' : commercial} disabled={!!mine} onChange={(e) => change(setCommercial)(e.target.value)} className={`${selectCls} w-[calc(50%-0.25rem)] sm:w-auto`}>
            <option value="">Tous les commerciaux</option>
            {data?.commerciaux.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
          </select>
          <select aria-label="Statut" value={statut} onChange={(e) => change(setStatut)(e.target.value)} className={`${selectCls} w-[calc(50%-0.25rem)] sm:w-auto`}>
            {STATUT_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select aria-label="Formation" value={formation} onChange={(e) => change(setFormation)(e.target.value)} className={`${selectCls} w-full sm:w-auto sm:max-w-[16rem]`}>
            <option value="">Toutes les formations</option>
            {formation && !formations.some((f) => f.key === formation) && <option value={formation}>{formation}</option>}
            {formations.map((f) => <option key={f.key} value={f.key}>{f.nom} ({f.count})</option>)}
          </select>
          <div className="relative flex-1 min-w-[12rem]">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"><Icons.Search /></span>
            <input
              type="search"
              value={qInput}
              onChange={(e) => { setQInput(e.target.value); setPage(1) }}
              placeholder="Nom ou email du professionnel de santé"
              aria-label="Recherche par nom ou email du professionnel de santé"
              className="w-full h-9 pl-8 pr-2.5 border border-zinc-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting || !data || data.total === 0}
            className="flex items-center gap-1.5 h-9 px-3 border border-zinc-200 rounded-lg bg-white text-xs font-medium text-zinc-700 hover:border-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {exporting ? <Icons.Loader /> : <Icons.Download />}
            Exporter (CSV)
          </button>
        </div>
        {exportError && <p className="-mt-3 mb-4 text-xs text-zinc-600">{exportError}</p>}

        {/* Indicateurs : équipe toujours visible, à côté de la personne connectée */}
        {data && (
          <div className={`grid grid-cols-1 ${data.stats.perso ? 'md:grid-cols-2' : ''} gap-3 mb-6`} data-zone="indicateurs">
            <StatsPanel title="Équipe" stats={data.stats.equipe} />
            {data.stats.perso && <StatsPanel title="Mes envois" stats={data.stats.perso} />}
          </div>
        )}

        {showReliability && (
          <div className="mb-3 flex items-start gap-2 text-xs text-zinc-500" data-alerte="fiabilite">
            <Icons.Alert />
            <span>Taux d&apos;ouverture antérieurs au {frDay(since!)} surestimés (copie commerciale comptée).</span>
          </div>
        )}

        {/* Tableau */}
        <div className="bg-white border border-zinc-200 rounded-xl shadow-sm overflow-hidden" data-vue={shownKey} data-etat={loading || refreshing ? 'chargement' : 'pret'}>

          {data && !loading && !error && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 border-b border-zinc-100 text-xs text-zinc-500" data-zone="vue">
              <span className="font-medium text-zinc-700">{data.total.toLocaleString('fr-FR')} mail{data.total > 1 ? 's' : ''}{filtered || mine ? ' dans cette vue' : ''}</span>
              <span>{data.stats.vue.opened.toLocaleString('fr-FR')} ouvert{data.stats.vue.opened > 1 ? 's' : ''} ({pct(data.stats.vue.opened, data.stats.vue.sent)})</span>
              <span>{data.stats.vue.clicked.toLocaleString('fr-FR')} cliqué{data.stats.vue.clicked > 1 ? 's' : ''} ({pct(data.stats.vue.clicked, data.stats.vue.sent)})</span>
              {refreshing && <span className="inline-flex items-center gap-1 text-zinc-400"><Icons.Loader /> Mise à jour…</span>}
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-zinc-400">
              <Icons.Loader />
              <span className="text-sm">Chargement…</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-24 gap-2 text-zinc-500">
              <span className="text-sm">{error}</span>
              <button onClick={() => fetchData()} className="text-xs text-zinc-400 underline">
                Réessayer
              </button>
            </div>
          )}

          {!loading && !error && data?.emails.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-zinc-400">
              <Icons.Empty />
              <div className="text-center">
                <p className="text-sm font-medium text-zinc-600">{filtered || mine ? 'Aucun mail ne correspond à ces filtres' : 'Aucun mail envoyé sur cette période'}</p>
                <p className="text-xs text-zinc-400 mt-0.5">{filtered || mine ? 'Élargis la période ou retire un filtre.' : "Les mails envoyés via l'Agent Mail apparaîtront ici"}</p>
              </div>
            </div>
          )}

          {!loading && !error && data && data.emails.length > 0 && (
            <>
              <div className="overflow-x-auto -mx-0 sm:mx-0">
                <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                  {/* Mobile : 3 colonnes (PS, statut, détail) ; largeurs fixées pour que le nom reste lisible */}
                  <colgroup>
                    <col />
                    <col className="hidden sm:table-column" />
                    <col className="hidden sm:table-column" />
                    <col className="w-[7.5rem] sm:w-auto" />
                    <col className="hidden sm:table-column" />
                    <col className="w-10 sm:w-auto" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-zinc-100">
                      <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Pro de santé</th>
                      <th className="hidden sm:table-cell text-left px-4 py-3 text-xs font-medium text-zinc-500">Commercial</th>
                      <th className="hidden sm:table-cell text-left px-4 py-3 text-xs font-medium text-zinc-500">Formation</th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-zinc-500">Statut</th>
                      <th className="hidden sm:table-cell text-left px-4 py-3 text-xs font-medium text-zinc-500">Envoyé</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.emails.map((email) => {
                      const isExpanded = expanded === email.resend_id
                      return (
                        <Fragment key={email.resend_id}>
                          <tr
                            onClick={() => setExpanded(isExpanded ? null : email.resend_id)}
                            className={`border-b border-zinc-50 cursor-pointer transition-colors ${
                              isExpanded ? 'bg-zinc-50' : 'hover:bg-zinc-50'
                            }`}
                          >
                            <td className="px-4 py-3">
                              <div className="font-medium text-zinc-900 truncate text-sm" title={email.ps_nom}>{abrevTitre(email.ps_nom)}</div>
                              <div className="text-xs text-zinc-400 truncate" title={email.ps_email}>{email.ps_email}</div>
                              <div className="sm:hidden text-[11px] text-zinc-400 truncate mt-0.5">{(email.commercial_name || '').split(' ')[0]} · {formatRelative(email.sent_at)}</div>
                            </td>
                            <td className="hidden sm:table-cell px-4 py-3 text-xs text-zinc-700 truncate">
                              {(email.commercial_name || '').split(' ')[0]}
                            </td>
                            <td className="hidden sm:table-cell px-4 py-3">
                              <div className="text-xs text-zinc-700 leading-snug line-clamp-2" title={email.formation_nom}>
                                {email.formation_nom}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <StatutBadge statut={email.statut} />
                              {email.relance && <div className="text-[11px] text-zinc-500 mt-1">Relancé {formatRelative(email.relance.sent_at)}</div>}
                            </td>
                            <td className="hidden sm:table-cell px-4 py-3">
                              <span className="text-xs text-zinc-500" title={formatFull(email.sent_at)}>
                                {formatRelative(email.sent_at)}
                              </span>
                            </td>
                            <td className="px-2 sm:px-4 py-3">
                              <div className="flex items-center justify-end gap-3">
                                {email.contact_id && (
                                  <a
                                    href={`https://app-eu1.hubspot.com/contacts/26228968/contacts/${email.contact_id}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="hidden sm:inline-flex text-xs text-zinc-400 hover:text-zinc-600 transition-colors items-center gap-1"
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
                            <tr className="bg-zinc-50 border-b border-zinc-100">
                              <td colSpan={visibleCols} className="px-4 py-3">
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                                  <div>
                                    <div className="text-zinc-400 mb-1.5 font-medium">Sujet</div>
                                    <div className="text-zinc-700">{email.sujet}</div>
                                    <div className="sm:hidden mt-2 text-zinc-500">{email.formation_nom}</div>
                                  </div>
                                  <div>
                                    <div className="text-zinc-400 mb-1.5 font-medium">Événements</div>
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-2 text-zinc-600">
                                        <Icons.Send />
                                        <span>Envoyé le {formatFull(email.sent_at)}{email.sent_by_name ? ` par ${email.sent_by_name}` : ''}</span>
                                      </div>
                                      {(email.first_opened_at || email.opened_at) ? (
                                        <div className="flex items-center gap-2 text-zinc-800">
                                          <Icons.Eye />
                                          <span>Ouvert le {formatFull((email.first_opened_at || email.opened_at)!)}{email.open_count && email.open_count > 1 ? ` (${email.open_count} ouvertures)` : ''}</span>
                                        </div>
                                      ) : (
                                        <div className="flex items-center gap-2 text-zinc-300">
                                          <Icons.Eye />
                                          <span>Pas encore ouvert</span>
                                        </div>
                                      )}
                                      {(email.first_clicked_at || email.clicked_at) ? (
                                        <div className="flex items-center gap-2 text-zinc-800">
                                          <Icons.Click />
                                          <span>Cliqué le {formatFull((email.first_clicked_at || email.clicked_at)!)}{email.click_count && email.click_count > 1 ? ` (${email.click_count} clics)` : ''}</span>
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
                                    <div className="text-zinc-400 mb-1.5 font-medium">Référence de l&apos;envoi</div>
                                    <div className="font-mono text-zinc-400 text-[10px] break-all">{email.resend_id}</div>
                                    {email.contact_id && (
                                      <a
                                        href={`https://app-eu1.hubspot.com/contacts/26228968/contacts/${email.contact_id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="sm:hidden mt-2 inline-flex text-xs text-zinc-500 hover:text-zinc-700 items-center gap-1"
                                      >
                                        Fiche HubSpot <Icons.ExternalLink />
                                      </a>
                                    )}
                                  </div>
                                </div>
                                <div className="mt-4 pt-3 border-t border-zinc-200 text-xs" data-zone="relance">
                                  <div className="text-zinc-400 mb-1.5 font-medium">Relance</div>
                                  {email.relance ? (
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-700">
                                      <span className="flex items-center gap-1.5"><Icons.Send /> Relance envoyée le {formatFull(email.relance.sent_at)}</span>
                                      <StatutBadge statut={email.relance.statut} />
                                      {email.relance.sent_by_name && <span className="text-zinc-500">par {email.relance.sent_by_name}</span>}
                                    </div>
                                  ) : (
                                    <div className="flex flex-wrap items-center gap-3">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setRelanceId(email.resend_id) }}
                                        disabled={!email.relance_possible}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 text-white font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                      >
                                        <Icons.Send /> Relancer
                                      </button>
                                      {!email.relance_possible && email.relance_bloquee && <span className="text-zinc-500">{email.relance_bloquee}</span>}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {data.pages > 1 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-4 py-3 border-t border-zinc-100">
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

        {relanceId && (
          <RelancePanel id={relanceId} onClose={closeRelance} onSent={() => { cacheRef.current.clear(); fetchData(true) }} />
        )}

        <div className="mt-4 text-center text-xs text-zinc-400">
          Mise à jour automatique toutes les minutes (en pause quand l&apos;onglet est caché) ·{' '}
          <button className="hover:underline" onClick={() => fetchData(true)}>
            Forcer l&apos;actualisation
          </button>
        </div>

      </div>
    </div>
  )
}
