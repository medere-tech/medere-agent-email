'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────
interface Commercial { id: string; hubspot_id: string; name: string; email: string; phone: string; slack_user_id: string }
interface Formation { id: string; nom: string; numero: string; format: string; public: string[] }
interface Session { id: string; session_id: string; numero: string; date_debut: string; date_cv1: string; date_cv2: string; temps_lisible: string }
interface HSContact { id: string; firstname: string; lastname: string; email: string; specialite?: string; rpps?: string }

type Step = 1 | 2 | 3 | 4 | 5 | 6

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

  // UI states
  const [loading, setLoading] = useState(false)
  const [loadingFormations, setLoadingFormations] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [contactSearch, setContactSearch] = useState('')
  const [contactSearching, setContactSearching] = useState(false)
  const [sendResult, setSendResult] = useState<any>(null)
  const [error, setError] = useState('')

  // Load commerciaux on mount
  useEffect(() => {
    fetch('/api/commerciaux')
      .then((r) => r.json())
      .then((d) => setCommerciauxList(d.commerciaux || []))
  }, [])

  // Load formations when step 2
  useEffect(() => {
    if (step === 2 && formations.length === 0) {
      setLoadingFormations(true)
      fetch('/api/formations')
        .then((r) => r.json())
        .then((d) => setFormationsList(d.formations || []))
        .finally(() => setLoadingFormations(false))
    }
  }, [step, formations.length])

  // Load sessions when formation selected
  useEffect(() => {
    if (!formation) return
    setLoadingSessions(true)
    setSessionsList([])
    setSelectedSessions([])
    fetch(`/api/sessions?formationId=${formation.id}`)
      .then((r) => r.json())
      .then((d) => setSessionsList(d.sessions || []))
      .finally(() => setLoadingSessions(false))
  }, [formation])

  // Contact search debounce
  useEffect(() => {
    if (contactSearch.length < 2) { setContactResults([]); return }
    const t = setTimeout(() => {
      setContactSearching(true)
      fetch(`/api/contact-search?q=${encodeURIComponent(contactSearch)}`)
        .then((r) => r.json())
        .then((d) => setContactResults(d.contacts || []))
        .finally(() => setContactSearching(false))
    }, 350)
    return () => clearTimeout(t)
  }, [contactSearch])

  const toggleSession = (s: Session) => {
    setSelectedSessions((prev) =>
      prev.find((p) => p.id === s.id) ? prev.filter((p) => p.id !== s.id) : [...prev, s]
    )
  }

  const handleGenerate = async () => {
    if (!commercial || !formation || !selectedSessions.length || !psContact) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commercial: { name: commercial.name, email: commercial.email, phone: commercial.phone || '' },
          formation: { id: formation.id, nom: formation.nom, numero: formation.numero, format: formation.format, public: formation.public },
          sessions: selectedSessions.map((s) => ({
            numero: s.numero,
            date_cv1: s.date_cv1,
            date_cv2: s.date_cv2,
            date_debut: s.date_debut,
            temps_lisible: s.temps_lisible,
          })),
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
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setMailSujet(data.sujet)
      setMailCorps(data.corps)
      setStep(5)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSend = async () => {
    if (!commercial || !psContact || !mailSujet || !mailCorps) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commercial: {
            name: commercial.name,
            email: commercial.email,
            hubspot_id: commercial.hubspot_id,
            slack_user_id: commercial.slack_user_id,
          },
          ps: {
            id: psContact.id,
            titre: psTitre,
            nom: psContact.lastname,
            prenom: psContact.firstname,
            email: psContact.email,
            rpps: psContact.rpps || '',
          },
          formation: { nom: formation!.nom, numero: formation!.numero },
          sujet: mailSujet,
          corps: mailCorps,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setSendResult(data)
      setStep(6)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const reset = () => {
    setStep(1)
    setCommercial(null)
    setFormation(null)
    setSelectedSessions([])
    setPsContact(null)
    setContactSearch('')
    setContactResults([])
    setMailSujet('')
    setMailCorps('')
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
    5: !!mailSujet && !!mailCorps,
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex items-start justify-center py-8 px-4">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="3" width="8" height="18" rx="4" fill="#111111"/>
                <rect x="14" y="3" width="8" height="18" rx="4" fill="#111111"/>
              </svg>
            </div>
            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Médéré</span>
          </div>
          <h1 className="text-xl font-semibold text-zinc-900">Agent Mail DPC</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Génère et envoie un mail personnalisé en moins de 60 secondes | <a href="/suivi">Voir le suivi des emails</a></p>
          <p className="text-sm text-zinc-500 mt-0.5"> <a href="/suivi">Voir le suivi des emails</a></p>
        </div>

        {/* Card */}
        <div className="bg-white border border-zinc-200 rounded-xl shadow-sm p-6">
          {step < 6 && <StepIndicator current={step} />}

          {/* Error */}
          {error && (
            <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
              <Icons.Warning />
              <span>{error}</span>
            </div>
          )}

          {/* ── STEP 1 : Commercial ── */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-zinc-900 mb-0.5">Qui envoie ce mail ?</h2>
                <p className="text-sm text-zinc-500">Sélectionne ton nom pour personnaliser la signature.</p>
              </div>
              <Select
                options={commerciaux.map((c) => ({ label: c.name, ...c }))}
                value={commercial ? { label: commercial.name, ...commercial } : null}
                onChange={(v) => setCommercial(v as any)}
                placeholder="Sélectionner un commercial..."
              />
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

              {contactSearch.length >= 2 && !contactSearching && contactResults.length === 0 && !psContact && (
                <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg flex items-start gap-2 text-sm text-amber-700">
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
                <p className="text-sm text-zinc-500">Vérifie et modifie si nécessaire avant d'envoyer.</p>
              </div>

              <div className="space-y-2.5">
                <div>
                  <label className="block text-xs font-medium text-zinc-500 mb-1">Sujet</label>
                  <input
                    type="text"
                    value={mailSujet}
                    onChange={(e) => setMailSujet(e.target.value)}
                    className="w-full px-3.5 py-2.5 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-zinc-500">Corps du mail</label>
                    <span className="text-[10px] text-zinc-400">{mailCorps.length} caractères</span>
                  </div>
                  <textarea
                      value={mailCorps}
                      onChange={(e) => setMailCorps(e.target.value)}
                      rows={14}
                      className="w-full px-3.5 py-2.5 border border-zinc-200 rounded-lg text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-900/10 resize-y"
                    />

                    {/* Affichage du corps du mail avec rendu HTML (à décommenter en fonction des retours des commerciaux) */}
                    {/* <div className="mt-2 p-3.5 border border-zinc-100 rounded-lg bg-zinc-50 text-sm text-zinc-700 leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: mailCorps.replace(/\n/g, '<br>') }}
                    /> */}
                </div>
              </div>

              <div className="p-3 bg-zinc-50 border border-zinc-200 rounded-lg flex items-center gap-2.5 text-xs text-zinc-600">
                <Icons.Mail />
                <span>Envoi vers <strong>{psContact?.email}</strong> · De la part de <strong>{commercial?.name}</strong></span>
              </div>

              <div className="flex gap-2">
                <button onClick={() => setStep(4)} className="px-4 py-2.5 border border-zinc-200 text-sm font-medium rounded-lg hover:bg-zinc-50 transition-colors">
                  Retour
                </button>
                <button
                  onClick={handleSend}
                  disabled={!canProceed[5] || loading}
                  className="flex-1 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                >
                  {loading ? <><Icons.Loader /> Envoi en cours...</> : <><Icons.Send /> Envoyer le mail</>}
                </button>
              </div>
            </div>
          )}

          {/* ── STEP 6 : Succès ── */}
          {step === 6 && sendResult && (
            <div className="space-y-5 py-2">
              <div className="flex flex-col items-center text-center gap-3 py-4">
                <div className="text-green-600">
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
                  label="Activité HubSpot"
                  ok={sendResult.hubspot_logged}
                  disabled={sendResult.hubspot_disabled}
                  detail={sendResult.hubspot_disabled ? 'Scope crm.objects.contacts.write requis' : sendResult.hubspot_logged ? 'Loggé sur les "Notes" du commercial' : 'Erreur'}
                />
                <StatusRow
                  icon={<Icons.Calendar />}
                  label="Relance J+3 programmée"
                  ok={sendResult.relance_stored}
                  detail={sendResult.relance_stored ? `Le ${formatDateShort(sendResult.relance_date)}` : 'Vercel KV non configuré'}
                />
              </div>

              {/* Pending actions */}
              {(sendResult.hubspot_disabled || !sendResult.relance_stored) && (
                <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-700 space-y-1">
                  {sendResult.hubspot_disabled && (
                    <p>⚠️ <strong>HubSpot log :</strong> Ajoute le scope <code>crm.objects.contacts.write</code> à ta private app + active <code>HS_WRITE_SCOPE_ENABLED=true</code> dans les env vars.</p>
                  )}
                  {!sendResult.relance_stored && (
                    <p>⚠️ <strong>Relance J+3 :</strong> Configure Vercel KV dans le dashboard Vercel et ajoute les env vars <code>KV_REST_API_URL</code> + <code>KV_REST_API_TOKEN</code>.</p>
                  )}
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
        </div>

        {/* Footer */}
        <div className="mt-4 text-center text-xs text-zinc-400">
          Créé par <a href="https://dethie.fr/blog/" target="_blank" className="hover:underline">Dethie</a> | Copyright © 2026 Médéré · Tous droits réservés
        </div>
      </div>
    </div>
  )
}

function StatusRow({ icon, label, ok, disabled, detail }: {
  icon: React.ReactNode; label: string; ok: boolean; disabled?: boolean; detail?: string
}) {
  return (
    <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-zinc-100 last:border-0 bg-white">
      <div className="flex items-center gap-2 text-sm text-zinc-700">
        <span className="text-zinc-400">{icon}</span>
        {label}
      </div>
      <div className="flex items-center gap-1.5">
        {detail && <span className="text-[11px] text-zinc-400">{detail}</span>}
        <div className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-green-500' : disabled ? 'bg-amber-400' : 'bg-red-400'}`} />
      </div>
    </div>
  )
}

function formatDateShort(d: string) {
  if (!d) return ''
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(new Date(d))
  } catch { return d }
}