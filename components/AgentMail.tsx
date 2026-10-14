'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { linkWarnings, renderMail } from '@/lib/render-mail'
import { parseGeneratedMail } from '@/lib/generated-mail'
import { checkDates } from '@/lib/session-label'

// ─── Types ────────────────────────────────────────────────────────────────────
// Fiche commercial (id Airtable) : le serveur relit nom, email, HubSpot et Slack à partir de l'id
interface Commercial { id: string; name: string; email: string }
// Personne connectée (rôle déterminé côté serveur)
interface Me { email: string; name: string; role: 'admin' | 'commercial' | 'lecteur'; commercial: Commercial | null; aujourdhui?: string }
interface Formation { id: string; nom: string; numero: string; format: string; public: string[] }
interface Session { id: string; session_id: string; numero: string; date_debut: string; date_cv1: string; date_cv2: string; temps_lisible: string }
interface HSContact { id: string; firstname: string; lastname: string; email: string; specialite?: string; rpps?: string }

// Envoi récent au même contact (alerte « déjà contacté » de l'étape 4)
interface HistoryItem { relance: boolean; commercial: string; envoyeLe: string; formation: string; statut: string }

type Step = 1 | 2 | 3 | 4 | 5 | 6

const SESSION_EXPIRED = 'Session expirée, reconnecte-toi.'

// fetch + contrôle de res.ok. Lève une erreur lisible si la réponse est en erreur
// ou n'est pas du JSON (ex. session expirée : le middleware redirige vers /login).
async function fetchJson(url: string, init?: RequestInit) {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error('Connexion impossible. Vérifie ta connexion internet puis réessaie.')
  }
  if (res.redirected && new URL(res.url).pathname === '/login') {
    throw new Error(SESSION_EXPIRED)
  }
  let data: any
  try {
    data = await res.json()
  } catch {
    throw new Error('Une erreur est survenue. Réessaie dans quelques instants.')
  }
  if (!res.ok) throw new Error(data?.error || 'Une erreur est survenue. Réessaie dans quelques instants.')
  return data
}

// Message d'erreur de chargement lisible : le détail technique reste dans les journaux du serveur
function loadError(e: any, what: string): string {
  if (e?.message === SESSION_EXPIRED) return SESSION_EXPIRED
  return `Impossible de charger ${what}. Réessaie dans quelques instants.`
}

// ─── Icons ────────────────────────────────────────────────────────────────────
const Icons = {
  Check: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 8L6.5 11.5L13 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  ChevronDown: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  Search: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M10.5 10.5L13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  User: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M2.5 13.5C2.5 11.015 5.015 9 8 9C10.985 9 13.5 11.015 13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  Mail: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M1.5 5.5L8 9.5L14.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  Send: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M13.5 2.5L7 9M13.5 2.5L9.5 13.5L7 9M13.5 2.5L2.5 6.5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  Sparkle: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5L9.5 6.5L14.5 8L9.5 9.5L8 14.5L6.5 9.5L1.5 8L6.5 6.5L8 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  ),
  Calendar: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M1.5 6.5H14.5" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M5 1.5V3.5M11 1.5V3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  Warning: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
      <path d="M8 7V9.5M8 11.5V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  CircleCheck: () => (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M10 16L14 20L22 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  Loader: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="animate-spin">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="10"/>
    </svg>
  ),
  Logout: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M6 2.5H3.5C2.95 2.5 2.5 2.95 2.5 3.5V12.5C2.5 13.05 2.95 13.5 3.5 13.5H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M10.5 11L13.5 8L10.5 5M13.5 8H6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
}

// ─── Step Indicator ───────────────────────────────────────────────────────────
const steps = [
  { n: 1, label: 'Commercial' },
  { n: 2, label: 'Formation' },
  { n: 3, label: 'Sessions' },
  { n: 4, label: 'Contact PS' },
  { n: 5, label: 'Aperçu' },
  { n: 6, label: 'Envoi' },
]

function StepIndicator({ current }: { current: Step }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center flex-1 last:flex-none">
          <div className="flex flex-col items-center gap-1">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium transition-all duration-200 ${
                s.n < current
                  ? 'bg-zinc-900 text-white'
                  : s.n === current
                  ? 'bg-zinc-900 text-white ring-4 ring-zinc-900/10'
                  : 'bg-zinc-100 text-zinc-400'
              }`}
            >
              {s.n < current ? <Icons.Check /> : s.n}
            </div>
            <span className={`text-[10px] font-medium hidden sm:block ${s.n <= current ? 'text-zinc-700' : 'text-zinc-400'}`}>
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px flex-1 mx-1 mb-4 transition-colors ${s.n < current ? 'bg-zinc-900' : 'bg-zinc-200'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Select Component ─────────────────────────────────────────────────────────
function Select<T extends { id: string; label: string }>({
  options, value, onChange, placeholder, loading, searchable = false,
}: {
  options: T[]
  value: T | null
  onChange: (v: T) => void
  placeholder: string
  loading?: boolean
  searchable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = searchable && search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 bg-white border border-zinc-200 rounded-lg text-sm hover:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 transition-all"
      >
        <span className={value ? 'text-zinc-900' : 'text-zinc-400'}>
          {loading ? 'Chargement...' : value ? value.label : placeholder}
        </span>
        <Icons.ChevronDown />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-zinc-200 rounded-lg shadow-lg overflow-hidden">
          {searchable && (
            <div className="p-2 border-b border-zinc-100">
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Rechercher..."
                className="w-full px-2.5 py-1.5 text-sm bg-zinc-50 rounded-md focus:outline-none"
              />
            </div>
          )}
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3.5 py-2.5 text-sm text-zinc-400">Aucun résultat</div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o); setOpen(false); setSearch('') }}
                  className={`w-full text-left px-3.5 py-2.5 text-sm hover:bg-zinc-50 flex items-center justify-between ${
                    value?.id === o.id ? 'text-zinc-900 font-medium' : 'text-zinc-700'
                  }`}
                >
                  {o.label}
                  {value?.id === o.id && <Icons.Check />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function AgentMail() {
  const [step, setStep] = useState<Step>(1)

  // Data
  const [commerciaux, setCommerciauxList] = useState<Commercial[]>([])
  const [formations, setFormationsList] = useState<Formation[]>([])
  const [sessions, setSessionsList] = useState<Session[]>([])
  const [contactResults, setContactResults] = useState<HSContact[]>([])

  // Selections
  const [commercial, setCommercial] = useState<Commercial | null>(null)
  const [formation, setFormation] = useState<Formation | null>(null)
  const [selectedSessions, setSelectedSessions] = useState<Session[]>([])
  const [psContact, setPsContact] = useState<HSContact | null>(null)
  const [psTitre, setPsTitre] = useState('Docteur')

  // Mail
  const [mailSujet, setMailSujet] = useState('')
  const [mailCorps, setMailCorps] = useState('')
  // Clé d'idempotence de l'envoi : créée à l'arrivée en étape 5, réutilisée pour
  // tout renvoi de ce mail (double clic, timeout) → Resend ne l'envoie qu'une fois.
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const sendingRef = useRef(false)
  // Rédaction en cours (texte affiché au fil de l'eau) ; annulable par « Retour »
  const [generating, setGenerating] = useState(false)
  const genAbortRef = useRef<AbortController | null>(null)
  // Étape 5 : texte modifiable ou aperçu du mail tel que reçu
  const [view, setView] = useState<'texte' | 'apercu'>('texte')
  // Envois récents au contact choisi (null = pas encore vérifié)
  const [history, setHistory] = useState<{ contactId: string; jours: number; envois: HistoryItem[]; failed: boolean } | null>(null)

  // UI states
  const [loading, setLoading] = useState(false)
  const [loadingFormations, setLoadingFormations] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [contactSearch, setContactSearch] = useState('')
  const [contactSearching, setContactSearching] = useState(false)
  const [contactSearchFailed, setContactSearchFailed] = useState(false)
  const [sendResult, setSendResult] = useState<any>(null)
  const [error, setError] = useState('')
  // Personne connectée ; blocked = accès refusé (compte désactivé, session expirée…)
  const [me, setMe] = useState<Me | null>(null)
  const [blocked, setBlocked] = useState('')

  // Au chargement : rôle de la personne connectée, puis préchargements (formations, liste des
  // commerciaux pour un administrateur, cache des sessions côté serveur) pour que chaque étape
  // s'affiche sans attente.
  useEffect(() => {
    fetchJson('/api/me')
      .then((m: Me) => {
        setMe(m)
        if (m.role === 'lecteur') return
        if (m.commercial) setCommercial(m.commercial)
        fetchJson('/api/sessions?warm=1').catch(() => {})
        if (m.role === 'admin') {
          fetchJson('/api/commerciaux')
            .then((d) => setCommerciauxList(d.commerciaux || []))
            .catch((e) => setError(loadError(e, 'la liste des commerciaux')))
        }
        setLoadingFormations(true)
        fetchJson('/api/formations')
          .then((d) => setFormationsList(d.formations || []))
          .catch((e) => setError(loadError(e, 'la liste des formations')))
          .finally(() => setLoadingFormations(false))
      })
      .catch((e) => setBlocked(e.message))
  }, [])

  // Formations pas encore chargées (préchargement en échec) : nouvel essai à l'étape 2
  useEffect(() => {
    if (step === 2 && formations.length === 0 && !loadingFormations) {
      setLoadingFormations(true)
      fetchJson('/api/formations')
        .then((d) => setFormationsList(d.formations || []))
        .catch((e) => setError(loadError(e, 'la liste des formations')))
        .finally(() => setLoadingFormations(false))
    }
  }, [step, formations.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load sessions when formation selected
  useEffect(() => {
    if (!formation) return
    setLoadingSessions(true)
    setSessionsList([])
    setSelectedSessions([])
    fetchJson(`/api/sessions?formationId=${formation.id}&format=${encodeURIComponent(formation.format)}`)
      .then((d) => setSessionsList(d.sessions || []))
      .catch((e) => setError(loadError(e, 'les sessions')))
      .finally(() => setLoadingSessions(false))
  }, [formation])

  // Recherche de contact progressive : la première passe HubSpot s'affiche dès qu'elle arrive,
  // les passes complémentaires sont AJOUTÉES à la suite (aucun réordonnancement, la liste ne saute
  // pas, la sélection n'est pas touchée). Une réponse d'une recherche plus ancienne est ignorée.
  const searchIdRef = useRef(0)
  useEffect(() => {
    setContactSearchFailed(false)
    if (contactSearch.length < 2) { setContactResults([]); return }
    const t = setTimeout(() => {
      const id = ++searchIdRef.current
      const search = (part: 'first' | 'rest') => fetchJson('/api/contact-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: contactSearch, part }),
      })
      setContactSearching(true)
      setContactResults([])
      let firstDone = false
      let firstFailed = false
      let pendingRest: HSContact[] | null = null
      const append = (list: HSContact[]) =>
        setContactResults((prev) => [...prev, ...list.filter((c) => !prev.some((p) => p.id === c.id))])
      const first = search('first')
        .then((d) => {
          if (id !== searchIdRef.current) return
          firstDone = true
          append(d.contacts || [])
          if (pendingRest) append(pendingRest)
        })
        .catch(() => { firstDone = true; firstFailed = true; if (pendingRest && id === searchIdRef.current) append(pendingRest) })
      const rest = search('rest')
        .then((d) => {
          if (id !== searchIdRef.current) return
          if (firstDone) append(d.contacts || [])
          else pendingRest = d.contacts || []
        })
        .then(() => false, () => true)
      Promise.all([first, rest]).then(([, restFailed]) => {
        if (id !== searchIdRef.current) return
        if (firstFailed && restFailed) setContactSearchFailed(true)
        setContactSearching(false)
      })
    }, 350)
    return () => clearTimeout(t)
  }, [contactSearch])

  // « Déjà contacté » : envois au même contact sur les 14 derniers jours, dès qu'il est choisi
  useEffect(() => {
    if (!psContact) { setHistory(null); return }
    let alive = true
    const contactId = psContact.id
    // POST : l'email du PS ne passe jamais dans l'adresse de la requête
    fetchJson('/api/contact-history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, email: psContact.email || '', rpps: psContact.rpps || '' }),
    })
      .then((d) => { if (alive) setHistory({ contactId, jours: d.jours || 14, envois: d.envois || [], failed: false }) })
      .catch(() => { if (alive) setHistory({ contactId, jours: 14, envois: [], failed: true }) })
    return () => { alive = false }
  }, [psContact])

  // Aperçu fidèle : même fonction de rendu que l'envoi ; avertissements une fois la rédaction finie
  const previewHtml = useMemo(() => renderMail(mailCorps).html, [mailCorps])
  const warnings = useMemo(() => (generating ? [] : linkWarnings(mailCorps)), [mailCorps, generating])
  // Jours de la semaine et dates de session déjà passées (date du jour du serveur), contrôlés sur le
  // texte final et à chaque modification
  const dateWarnings = useMemo(() => (generating ? [] : checkDates(`${mailSujet}
${mailCorps}`, me?.aujourdhui)), [mailSujet, mailCorps, generating, me?.aujourdhui])

  const toggleSession = (s: Session) => {
    setSelectedSessions((prev) =>
      prev.find((p) => p.id === s.id) ? prev.filter((p) => p.id !== s.id) : [...prev, s]
    )
  }

  // Rédaction affichée au fil de l'eau : l'étape 5 s'ouvre dès que le serveur commence à répondre,
  // l'objet puis le texte s'y écrivent progressivement (réponse NDJSON de /api/generate).
  const handleGenerate = async () => {
    if (!commercial || !formation || !selectedSessions.length || !psContact) return
    genAbortRef.current?.abort()
    const ctrl = new AbortController()
    genAbortRef.current = ctrl
    setLoading(true)
    setGenerating(true)
    setError('')
    setMailSujet('')
    setMailCorps('')
    setView('texte')
    let onStep5 = false
    try {
      let res: Response
      try {
        res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
        body: JSON.stringify({
          commercial_id: commercial.id,
          formation: { id: formation.id, nom: formation.nom, numero: formation.numero, format: formation.format, public: formation.public },
          // Identifiants seulement : dates et libellés relus et calculés côté serveur (Airtable)
          session_ids: selectedSessions.map((s) => s.id),
          ps: {
            titre: psTitre,
            nom: psContact.lastname,
            prenom: psContact.firstname,
            specialite: psContact.specialite,
            email: psContact.email,
            rpps: psContact.rpps || '',
          },
        }),
        })
      } catch {
        if (ctrl.signal.aborted) return
        throw new Error('Connexion impossible. Vérifie ta connexion internet puis réessaie.')
      }
      if (res.redirected && new URL(res.url).pathname === '/login') throw new Error(SESSION_EXPIRED)
      if (!res.ok || !res.body || !(res.headers.get('content-type') || '').includes('ndjson')) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || 'Une erreur est survenue. Réessaie dans quelques instants.')
      }
      setStep(5)
      onStep5 = true
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let raw = ''
      let finished = false
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          const event = JSON.parse(line)
          if (event.t === 'delta') {
            raw += event.d
            const parsed = parseGeneratedMail(raw)
            setMailSujet(parsed.sujet)
            setMailCorps(parsed.corps)
          } else if (event.t === 'done') {
            setMailSujet(event.sujet)
            setMailCorps(event.corps)
            finished = true
          } else if (event.t === 'error') {
            throw new Error(event.error)
          }
        }
      }
      if (!finished) throw new Error('La rédaction du mail a été interrompue. Réessaie.')
      setIdempotencyKey(crypto.randomUUID())
    } catch (e: any) {
      if (ctrl.signal.aborted) return
      setError(e.message)
      setMailSujet('')
      setMailCorps('')
      if (onStep5) setStep(4)
    } finally {
      if (genAbortRef.current === ctrl) {
        genAbortRef.current = null
        setLoading(false)
        setGenerating(false)
      }
    }
  }

  // « Retour » pendant la rédaction : la requête est annulée (le serveur arrête Claude)
  const cancelGenerate = () => {
    genAbortRef.current?.abort()
    genAbortRef.current = null
    setLoading(false)
    setGenerating(false)
    setMailSujet('')
    setMailCorps('')
    setStep(4)
  }

  const handleSend = async () => {
    if (!commercial || !psContact || !mailSujet || !mailCorps) return
    // Verrou synchrone : `loading` (state) n'est appliqué qu'au re-render suivant
    if (sendingRef.current) return
    sendingRef.current = true
    setLoading(true)
    setError('')
    try {
      const data = await fetchJson('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commercial_id: commercial.id,
          ps: {
            id: psContact.id,
            titre: psTitre,
            nom: psContact.lastname,
            prenom: psContact.firstname,
            email: psContact.email,
            rpps: psContact.rpps || '',
          },
          formation: { id: formation!.id, nom: formation!.nom, numero: formation!.numero },
          session_ids: selectedSessions.map((s) => s.id),
          sujet: mailSujet,
          corps: mailCorps,
          idempotencyKey,
        }),
      })
      setSendResult(data)
      setStep(6)
    } catch (e: any) {
      setError(e.message)
    } finally {
      sendingRef.current = false
      setLoading(false)
    }
  }

  const reset = () => {
    genAbortRef.current?.abort()
    setStep(1)
    setCommercial(me?.commercial ?? null)
    setFormation(null)
    setSelectedSessions([])
    setPsContact(null)
    setContactSearch('')
    setContactResults([])
    setMailSujet('')
    setMailCorps('')
    setIdempotencyKey('')
    setSendResult(null)
    setError('')
  }

  const formatDate = (d: string) => {
    if (!d) return ''
    try {
      return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d))
    } catch { return d }
  }

  const canProceed = {
    1: !!commercial,
    2: !!formation,
    3: selectedSessions.length > 0,
    4: !!psContact,
    5: !!mailSujet && !!mailCorps && !generating,
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex items-start justify-center py-8 px-4">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="2" y="3" width="8" height="18" rx="4" fill="#111111"/>
                  <rect x="14" y="3" width="8" height="18" rx="4" fill="#111111"/>
                </svg>
              </div>
              <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Médéré</span>
            </div>
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
          <h1 className="text-xl font-semibold text-zinc-900">Agent Mail DPC</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Génère et envoie un mail personnalisé en moins de 60 secondes</p>
          <p className="text-sm text-zinc-500 mt-0.5"> <a href="/suivi" className="hover:underline">Voir l'historique des emails</a></p>
        </div>

        {/* Card */}
        <div className="bg-white border border-zinc-200 rounded-xl shadow-sm p-6">
          {blocked ? (
            <div className="flex items-start gap-2 p-3 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-zinc-700">
              <Icons.Warning />
              <span>{blocked}</span>
            </div>
          ) : !me ? (
            <div className="flex items-center gap-2 py-6 justify-center text-sm text-zinc-400">
              <Icons.Loader /> Chargement...
            </div>
          ) : me.role === 'lecteur' ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-zinc-700">
                <Icons.User />
                <span>Ton compte n'est pas associé à une fiche commercial : tu peux consulter le suivi, mais pas générer ni envoyer de mail.</span>
              </div>
              <a href="/suivi" className="block w-full py-2.5 text-center bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors">
                Voir le suivi des envois
              </a>
            </div>
          ) : (<>
          {step < 6 && <StepIndicator current={step} />}

          {/* Error */}
          {error && (
            <div className="mb-4 flex items-start gap-2 p-3 bg-zinc-50 border border-zinc-400 rounded-lg text-sm text-zinc-900">
              <Icons.Warning />
              <span>{error}</span>
            </div>
          )}

          {/* ── STEP 1 : Commercial ── */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 mb-0.5">Qui envoie ce mail ?</h2>
                <p className="text-sm text-zinc-500">
                  {me.role === 'admin'
                    ? "Le mail part à ton nom par défaut. Tu peux aussi l'envoyer au nom de n'importe quel commercial actif : ce sera indiqué dans la Note HubSpot."
                    : 'Le mail part à ton nom, avec ta signature.'}
                </p>
              </div>
              {me.role === 'admin' ? (
                <Select
                  options={commerciaux.map((c) => ({ label: c.id === me.commercial?.id ? `${c.name} (moi)` : c.name, ...c }))}
                  value={commercial ? { label: commercial.id === me.commercial?.id ? `${commercial.name} (moi)` : commercial.name, ...commercial } : null}
                  onChange={(v) => setCommercial({ id: v.id, name: v.name, email: v.email })}
                  placeholder="Sélectionner un commercial..."
                />
              ) : (
                <div className="w-full flex items-center justify-between px-3.5 py-2.5 bg-zinc-50 border border-zinc-200 rounded-lg text-sm">
                  <span className="text-zinc-900">{commercial?.name}</span>
                  <span className="flex items-center gap-1 text-xs text-zinc-400"><Icons.User /> Ton compte</span>
                </div>
              )}
              <button
                onClick={() => setStep(2)}
                disabled={!canProceed[1]}
                className="w-full py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Continuer
              </button>
            </div>
          )}

          {/* ── STEP 2 : Formation ── */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 mb-0.5">Quelle formation ?</h2>
                <p className="text-sm text-zinc-500">Choisis la formation que le PS souhaite rejoindre.</p>
              </div>
              <Select
                options={formations.map((f) => ({ label: f.nom, ...f }))}
                value={formation ? { label: formation.nom, ...formation } : null}
                onChange={(v) => setFormation(v as any)}
                placeholder="Rechercher une formation..."
                loading={loadingFormations}
                searchable
              />
              {formation && (
                <div className="p-3 bg-zinc-50 rounded-lg space-y-1.5">
                  <div className="flex gap-2 text-xs">
                    <span className="text-zinc-500">N° DPC :</span>
                    <span className="font-mono font-medium text-zinc-700">{formation.numero}</span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="text-zinc-500">Format :</span>
                    <span className="text-zinc-700">{formation.format}</span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="text-zinc-500">Public :</span>
                    <span className="text-zinc-700">{formation.public?.join(', ') || '—'}</span>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => setStep(1)} className="px-4 py-2.5 border border-zinc-200 text-sm font-medium rounded-lg hover:bg-zinc-50 transition-colors">
                  Retour
                </button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!canProceed[2]}
                  className="flex-1 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Continuer
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 3 : Sessions ── */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 mb-0.5">Quelles sessions ?</h2>
                <p className="text-sm text-zinc-500">Sélectionne les sessions à proposer. Toutes seront mentionnées dans le mail.</p>
              </div>

              {loadingSessions ? (
                <div className="flex items-center gap-2 py-6 justify-center text-sm text-zinc-400">
                  <Icons.Loader /> Chargement des sessions...
                </div>
              ) : sessions.length === 0 ? (
                <div className="py-6 text-center text-sm text-zinc-400">Aucune session future disponible pour cette formation.</div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((s) => {
                    const selected = !!selectedSessions.find((ss) => ss.id === s.id)
                    const dateLabel = s.temps_lisible || (s.date_cv1 ? formatDate(s.date_cv1) : s.date_debut ? formatDate(s.date_debut) : '—')
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleSession(s)}
                        className={`w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all ${
                          selected ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 hover:border-zinc-300'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-colors ${selected ? 'bg-zinc-900 text-white' : 'border border-zinc-300'}`}>
                            {selected && <Icons.Check />}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-zinc-800">Session {s.numero}</div>
                            <div className="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                              <Icons.Calendar />{dateLabel}
                            </div>
                          </div>
                        </div>
                        {s.session_id && (
                          <span className="text-[10px] font-mono text-zinc-400">{s.session_id}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}

              {selectedSessions.length > 0 && (
                <div className="text-xs text-zinc-500">{selectedSessions.length} session{selectedSessions.length > 1 ? 's' : ''} sélectionnée{selectedSessions.length > 1 ? 's' : ''}</div>
              )}

              <div className="flex gap-2">
                <button onClick={() => setStep(2)} className="px-4 py-2.5 border border-zinc-200 text-sm font-medium rounded-lg hover:bg-zinc-50 transition-colors">
                  Retour
                </button>
                <button
                  onClick={() => setStep(4)}
                  disabled={!canProceed[3]}
                  className="flex-1 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Continuer
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 4 : Contact PS ── */}
          {step === 4 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 mb-0.5">Quel professionnel de santé ?</h2>
                <p className="text-sm text-zinc-500">Recherche par nom, prénom ou email dans HubSpot.</p>
              </div>

              <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">
                  {contactSearching ? <Icons.Loader /> : <Icons.Search />}
                </div>
                <input
                  type="text"
                  value={contactSearch}
                  onChange={(e) => { setContactSearch(e.target.value); setPsContact(null) }}
                  placeholder="Ex : Dupont Marie ou dupont@gmail.com"
                  className="w-full pl-9 pr-3.5 py-2.5 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10 focus:border-zinc-300"
                />
              </div>

              {/* Results */}
              {contactResults.length > 0 && !psContact && (
                <div className="border border-zinc-200 rounded-lg overflow-hidden">
                  {contactResults.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { setPsContact(c); setContactResults([]) }}
                      className="w-full flex items-center gap-3 px-3.5 py-2.5 hover:bg-zinc-50 border-b border-zinc-100 last:border-0 text-left"
                    >
                      <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-500 flex-shrink-0">
                        <Icons.User />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-zinc-800">{c.firstname} {c.lastname}</div>
                        <div className="text-xs text-zinc-500">{c.email}{c.specialite ? ` · ${c.specialite}` : ''}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {contactSearchFailed && !contactSearching && !psContact && (
                <div className="p-3 bg-zinc-50 border border-zinc-400 rounded-lg flex items-start gap-2 text-sm text-zinc-900">
                  <Icons.Warning />
                  <span>HubSpot indisponible, ne crée pas le contact. Réessaie dans quelques instants.</span>
                </div>
              )}

              {contactSearch.length >= 2 && !contactSearching && !contactSearchFailed && contactResults.length === 0 && !psContact && (
                <div className="p-3 bg-white border border-zinc-300 rounded-lg flex items-start gap-2 text-sm text-zinc-700">
                  <Icons.Warning />
                  <span>Aucun contact trouvé dans HubSpot. Vérifie l'orthographe ou crée le contact dans HubSpot d'abord.</span>
                </div>
              )}

              {/* Selected contact */}
              {psContact && (
                <div className="p-3.5 border border-zinc-200 rounded-lg space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-full bg-zinc-900 flex items-center justify-center text-white flex-shrink-0">
                        <Icons.User />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-zinc-900">{psContact.firstname} {psContact.lastname}</div>
                        <div className="text-xs text-zinc-500">{psContact.email}</div>
                      </div>
                    </div>
                    <button onClick={() => { setPsContact(null); setContactSearch('') }} className="text-xs text-zinc-400 hover:text-zinc-600 underline">
                      Changer
                    </button>
                  </div>

                  <div className="border-t border-zinc-100 pt-3">
                    <label className="block text-xs font-medium text-zinc-500 mb-1.5">Titre de politesse</label>
                    <div className="flex gap-2">
                      {['Docteur', 'Madame', 'Monsieur'].map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setPsTitre(t)}
                          className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                            psTitre === t ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {psContact && history?.contactId === psContact.id && history.envois.length > 0 && (
                <div className="p-3 bg-white border border-zinc-300 rounded-lg text-sm text-zinc-700" data-alerte="deja-contacte">
                  <div className="flex items-start gap-2 font-medium">
                    <Icons.Warning />
                    <span>Déjà contacté ces {history.jours} derniers jours</span>
                  </div>
                  <ul className="mt-1.5 ml-6 space-y-1 text-xs">
                    {history.envois.map((h, i) => (
                      <li key={i}>
                        {h.relance ? 'Relance' : 'Mail'} de <strong>{h.commercial}</strong> le {formatDateTime(h.envoyeLe)}
                        {h.formation ? <> · formation « {h.formation} »</> : null} · <strong>{h.statut}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {psContact && history?.contactId === psContact.id && history.failed && (
                <p className="text-xs text-zinc-500">Impossible de vérifier les envois récents à ce contact. Consulte le suivi avant d'envoyer.</p>
              )}

              <div className="flex gap-2">
                <button onClick={() => setStep(3)} className="px-4 py-2.5 border border-zinc-200 text-sm font-medium rounded-lg hover:bg-zinc-50 transition-colors">
                  Retour
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={!canProceed[4] || loading}
                  className="flex-1 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                  {loading ? <><Icons.Loader /> Génération en cours...</> : <><Icons.Sparkle /> Générer le mail</>}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 5 : Aperçu ── */}
          {step === 5 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 mb-0.5">Aperçu du mail</h2>
                <p className="text-sm text-zinc-500">
                  {generating ? 'Rédaction du mail en cours…' : 'Vérifie et modifie si nécessaire avant d\'envoyer.'}
                </p>
              </div>

              <div className="space-y-2.5">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1">Sujet</label>
                  <input
                    type="text"
                    value={mailSujet}
                    onChange={(e) => setMailSujet(e.target.value)}
                    readOnly={generating}
                    placeholder={generating ? 'Rédaction en cours…' : ''}
                    className="w-full px-3.5 py-2.5 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10 read-only:bg-zinc-50"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex gap-1" role="tablist">
                      {([['texte', 'Texte'], ['apercu', 'Aperçu']] as const).map(([v, label]) => (
                        <button
                          key={v}
                          type="button"
                          role="tab"
                          aria-selected={view === v}
                          onClick={() => setView(v)}
                          className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                            view === v ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <span className="flex items-center gap-1.5 text-[10px] text-zinc-400">
                      {generating && <Icons.Loader />}
                      {generating ? 'Rédaction en cours' : `${mailCorps.length} caractères`}
                    </span>
                  </div>

                  {view === 'texte' ? (
                    <textarea
                      value={mailCorps}
                      onChange={(e) => setMailCorps(e.target.value)}
                      readOnly={generating}
                      rows={14}
                      data-zone="texte"
                      className="w-full px-3.5 py-2.5 border border-zinc-200 rounded-lg text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-900/10 resize-y read-only:bg-zinc-50"
                    />
                  ) : (
                    <div className="border border-zinc-200 rounded-lg overflow-hidden bg-white" data-zone="apercu">
                      <div className="px-3.5 py-2.5 bg-zinc-50 border-b border-zinc-200 text-xs text-zinc-600 space-y-0.5">
                        <div><span className="text-zinc-400">De :</span> {commercial?.name} – Médéré</div>
                        <div><span className="text-zinc-400">À :</span> {psContact?.email}</div>
                        <div><span className="text-zinc-400">Objet :</span> <span className="font-medium text-zinc-900">{mailSujet}</span></div>
                      </div>
                      {/* Même HTML que le mail envoyé (renderMail), avec l'apparence par défaut d'une messagerie.
                          Un clic sur un lien l'ouvre dans un nouvel onglet, sans quitter l'agent. */}
                      <div
                        className="px-4 py-3.5 max-h-[28rem] overflow-y-auto break-words [&_a]:text-zinc-900 [&_a]:underline"
                        style={{ fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '14px', lineHeight: 1.5, color: '#27272a' }}
                        onClick={(e) => {
                          const a = (e.target as HTMLElement).closest('a')
                          if (a) { e.preventDefault(); window.open(a.href, '_blank', 'noopener,noreferrer') }
                        }}
                        dangerouslySetInnerHTML={{ __html: previewHtml }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {dateWarnings.length > 0 && (
                <div className="p-3 bg-white border border-zinc-900 rounded-lg text-sm text-zinc-900" data-alerte="dates">
                  <div className="flex items-start gap-2 font-medium">
                    <Icons.Warning />
                    <span>{dateWarnings.length === 1 ? 'Une date incohérente' : `${dateWarnings.length} dates incohérentes`} : corrige le texte avant l'envoi</span>
                  </div>
                  <ul className="mt-1.5 ml-6 space-y-1 text-xs">
                    {dateWarnings.map((w, i) => (
                      <li key={i}><span className="font-mono bg-zinc-100 px-1 rounded">{w.extrait}</span> : {w.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {warnings.length > 0 && (
                <div className="p-3 bg-white border border-zinc-300 rounded-lg text-sm text-zinc-700" data-alerte="liens">
                  <div className="flex items-start gap-2 font-medium">
                    <Icons.Warning />
                    <span>{warnings.length === 1 ? 'Un lien à vérifier' : `${warnings.length} liens à vérifier`} avant l'envoi</span>
                  </div>
                  <ul className="mt-1.5 ml-6 space-y-1 text-xs">
                    {warnings.map((w, i) => (
                      <li key={i}><span className="font-mono bg-white/60 px-1 rounded">{w.extrait}</span> : {w.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="p-3 bg-zinc-50 border border-zinc-200 rounded-lg flex items-center gap-2.5 text-xs text-zinc-600">
                <Icons.Mail />
                <span>Envoi vers <strong>{psContact?.email}</strong> · De la part de <strong>{commercial?.name}</strong></span>
              </div>

              <div className="flex gap-2">
                <button onClick={generating ? cancelGenerate : () => setStep(4)} className="px-4 py-2.5 border border-zinc-200 text-sm font-medium rounded-lg hover:bg-zinc-50 transition-colors">
                  Retour
                </button>
                <button
                  onClick={handleSend}
                  disabled={!canProceed[5] || loading}
                  className="flex-1 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                  {generating ? <><Icons.Loader /> Rédaction en cours...</> : loading ? <><Icons.Loader /> Envoi en cours...</> : <><Icons.Send /> Envoyer le mail</>}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 6 : Succès ── */}
          {step === 6 && sendResult && (
            <div className="space-y-5 py-2">
              <div className="flex flex-col items-center text-center gap-3 py-4">
                <div className="text-zinc-900">
                  <Icons.CircleCheck />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-zinc-900">Mail envoyé avec succès</h2>
                  <p className="text-sm text-zinc-500 mt-0.5">
                    {psTitre} {psContact?.firstname} {psContact?.lastname} a reçu ton mail.
                  </p>
                </div>
              </div>

              {/* Status checks */}
              <div className="space-y-2 border border-zinc-100 rounded-lg overflow-hidden">
                <StatusRow
                  icon={<Icons.Send />}
                  label="Mail envoyé"
                  ok={true}
                  detail={psContact?.email}
                />
                <StatusRow
                  icon={<Icons.Mail />}
                  label="Fiche HubSpot du PS"
                  ok={sendResult.hubspot_logged}
                  detail={sendResult.hubspot_logged ? 'Note ajoutée sur la fiche du PS' : 'Note non ajoutée (le mail est bien parti)'}
                />
                <StatusRow
                  icon={<Icons.Calendar />}
                  label="Rappel de relance programmé"
                  ok={sendResult.relance_stored}
                  detail={sendResult.relance_stored ? `Le ${formatDateShort(sendResult.relance_date)}` : 'Rappel non programmé'}
                />
              </div>

              {/* Pending actions */}
              {!sendResult.relance_stored && (
                <div className="p-3 bg-white border border-zinc-300 rounded-lg text-xs text-zinc-700 space-y-1">
                  <p>Le rappel n'a pas pu être programmé : pense à relancer ce PS toi-même dans 3 jours.</p>
                </div>
              )}

              <button
                onClick={reset}
                className="w-full py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors"
              >
                Nouveau mail
              </button>
            </div>
          )}
          </>)}
        </div>

        {/* Footer */}
        <div className="mt-4 text-center text-xs text-zinc-400">
          Créé par <a href="https://dethie.fr/blog/" target="_blank" className="hover:underline">Dethie</a> | Copyright © 2026 Médéré · Tous droits réservés
        </div>
      </div>
    </div>
  )
}

function StatusRow({ icon, label, ok, detail }: {
  icon: React.ReactNode; label: string; ok: boolean; detail?: string
}) {
  return (
    <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-zinc-100 last:border-0 bg-white">
      <div className="flex items-center gap-2 text-sm text-zinc-700">
        <span className="text-zinc-400">{icon}</span>
        {label}
      </div>
      <div className="flex items-center gap-1.5">
        {detail && <span className="text-[11px] text-zinc-400">{detail}</span>}
        <div className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-zinc-900' : 'border border-zinc-400 bg-white'}`} />
      </div>
    </div>
  )
}

function formatDateTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(new Date(iso))
  } catch {
    return ''
  }
}

function formatDateShort(d: string) {
  if (!d) return ''
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(new Date(d))
  } catch { return d }
}