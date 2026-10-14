'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { linkWarnings } from '@/lib/render-mail'
import { checkDates } from '@/lib/session-label'

// Fenêtre de relance d'un mail (ouverte depuis /suivi ou depuis le lien du DM Slack J+3) :
// objet et texte pré-remplis, modifiables, rédigés une seule fois par Claude (le bouton disparaît
// ensuite, le texte reste modifiable à la main), puis envoi dans le fil du
// mail d'origine. Le serveur refait tous les contrôles (auteur, une seule relance, statut, sessions
// encore ouvertes) ; il indique les sessions retenues (message) ou l'absence de session (relance
// impossible : rédaction et envoi désactivés).

interface Draft {
  id: string
  sujet: string
  corps: string
  statut: string
  redigee: boolean
  // Sessions relues dans Airtable : origine, remplacement, inconnues ou aucune (relance impossible)
  mode: 'origine' | 'remplacement' | 'inconnues' | 'aucune'
  message: string | null
  possible: boolean
  aujourdhui: string
  ps: { nom: string; email: string }
  formation: string
  envoyeLe: string
  commercial: string
  auNomDe: string | null
}

const Icon = {
  Close: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  Sparkle: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5L9.5 6.5L14.5 8L9.5 9.5L8 14.5L6.5 9.5L1.5 8L6.5 6.5L8 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>
  ),
  Send: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 2.5L7 9M13.5 2.5L9.5 13.5L7 9M13.5 2.5L2.5 6.5L7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  Warning: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M8 7V9.5M8 11.5V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
  ),
  Check: () => (
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5"/><path d="M10 16L14 20L22 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
  ),
  Loader: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="animate-spin"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="10"/></svg>
  ),
}

const GENERIC = 'Une erreur est survenue. Réessaie dans quelques instants.'

async function call(url: string, init?: RequestInit) {
  let res: Response
  try {
    res = await fetch(url, { cache: 'no-store', ...init })
  } catch {
    throw new Error('Connexion impossible. Vérifie ta connexion internet puis réessaie.')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || GENERIC)
  return data
}

function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
  } catch {
    return ''
  }
}

export default function RelancePanel({ id, onClose, onSent }: { id: string; onClose: () => void; onSent: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [sujet, setSujet] = useState('')
  const [corps, setCorps] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [generating, setGenerating] = useState(false)
  // Claude a déjà rédigé cette relance (ici ou ailleurs) : plus de bouton de rédaction
  const [redigee, setRedigee] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const sendingRef = useRef(false)
  // Liens mal formés (même contrôle que l'étape 5 de l'envoi), non bloquant
  const warnings = useMemo(() => linkWarnings(corps), [corps])
  // Jours de la semaine et dates de session déjà passées, contrôlés sur le texte de la relance
  // (et à chaque modification), avec la date du jour du serveur
  const dateWarnings = useMemo(() => (generating ? [] : checkDates(`${sujet}
${corps}`, draft?.aujourdhui)), [sujet, corps, generating, draft?.aujourdhui])
  const possible = draft?.possible !== false
  // Clé d'idempotence de cette relance : un double clic ou un renvoi n'envoie qu'une relance
  const keyRef = useRef(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))

  useEffect(() => {
    call(`/api/relance?id=${encodeURIComponent(id)}`)
      .then((d: Draft) => { setDraft(d); setSujet(d.sujet); setCorps(d.corps); setRedigee(d.redigee) })
      .catch((e) => setLoadError(e.message))
  }, [id])

  const regenerate = async () => {
    setGenerating(true)
    setError('')
    try {
      const d = await call('/api/relance/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      })
      setCorps(d.corps)
      setRedigee(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const send = async () => {
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError('')
    try {
      await call('/api/relance/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, sujet, corps, idempotencyKey: keyRef.current }),
      })
      setSent(true)
      onSent()
    } catch (e: any) {
      setError(e.message)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-zinc-900/40 px-4 py-6 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-2xl bg-white border border-zinc-200 rounded-xl shadow-lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-100">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">Relancer par mail</h2>
            {draft && (
              <p className="text-xs text-zinc-500 mt-0.5">
                {draft.ps.nom} · {draft.formation} · mail du {formatDate(draft.envoyeLe)} ({draft.statut})
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Fermer"><Icon.Close /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {loadError && (
            <div className="flex items-start gap-2 p-3 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-zinc-700">
              <Icon.Warning /><span>{loadError}</span>
            </div>
          )}

          {!draft && !loadError && (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-zinc-400"><Icon.Loader /> Préparation de la relance...</div>
          )}

          {draft && sent && (
            <div className="flex flex-col items-center text-center gap-2 py-6 text-zinc-700">
              <Icon.Check />
              <p className="text-sm font-medium text-zinc-900">Relance envoyée</p>
              <p className="text-xs text-zinc-500">{draft.ps.nom} l'a reçue à {draft.ps.email}. Elle apparaît sous le mail d'origine dans le suivi.</p>
              <button onClick={onClose} className="mt-2 px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800">Fermer</button>
            </div>
          )}

          {draft && !sent && (
            <>
              {draft.message && (
                <div className={`flex items-start gap-2 p-3 rounded-lg text-sm ${possible ? 'bg-zinc-50 border border-zinc-200 text-zinc-700' : 'bg-white border border-zinc-900 text-zinc-900'}`} data-alerte="sessions">
                  <Icon.Warning /><span>{draft.message}</span>
                </div>
              )}
              {draft.auNomDe && (
                <p className="text-xs text-zinc-500">La relance part au nom de {draft.auNomDe} ; tu seras indiqué comme expéditeur dans la Note HubSpot.</p>
              )}
              <div>
                <label className="block text-xs font-medium text-zinc-500 mb-1">Objet</label>
                <input
                  type="text"
                  value={sujet}
                  onChange={(e) => setSujet(e.target.value)}
                  className="w-full px-3.5 py-2.5 border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-zinc-500">Texte de la relance</label>
                  {!possible ? null : redigee ? (
                    <span className="text-xs text-zinc-400">Rédigée · modifiable à la main</span>
                  ) : (
                    <button
                      onClick={regenerate}
                      disabled={generating || sending}
                      className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-zinc-900 disabled:opacity-40"
                    >
                      {generating ? <><Icon.Loader /> Rédaction en cours...</> : <><Icon.Sparkle /> Rédiger la relance</>}
                    </button>
                  )}
                </div>
                <textarea
                  value={corps}
                  onChange={(e) => setCorps(e.target.value)}
                  rows={14}
                  className="w-full px-3.5 py-2.5 border border-zinc-200 rounded-lg text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-zinc-900/10 resize-y"
                />
              </div>
              {dateWarnings.length > 0 && (
                <div className="p-3 bg-white border border-zinc-900 rounded-lg text-xs text-zinc-900" data-alerte="dates">
                  <div className="flex items-start gap-2 font-medium">
                    <Icon.Warning />
                    <span>{dateWarnings.length === 1 ? 'Une date incohérente' : `${dateWarnings.length} dates incohérentes`} : corrige le texte avant l'envoi</span>
                  </div>
                  <ul className="mt-1.5 ml-6 space-y-1">
                    {dateWarnings.map((w, i) => (
                      <li key={i}><span className="font-mono bg-zinc-100 px-1 rounded">{w.extrait}</span> : {w.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {warnings.length > 0 && (
                <div className="p-3 bg-white border border-zinc-300 rounded-lg text-xs text-zinc-700" data-alerte="liens">
                  <div className="flex items-start gap-2 font-medium">
                    <Icon.Warning />
                    <span>{warnings.length === 1 ? 'Un lien à vérifier' : `${warnings.length} liens à vérifier`} avant l'envoi</span>
                  </div>
                  <ul className="mt-1.5 ml-6 space-y-1">
                    {warnings.map((w, i) => (
                      <li key={i}><span className="font-mono bg-white/60 px-1 rounded">{w.extrait}</span> : {w.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-zinc-500">
                Envoi vers <strong>{draft.ps.email}</strong> · De la part de <strong>{draft.commercial}</strong> · dans la même conversation que le mail d'origine
              </p>
              {error && (
                <div className="flex items-start gap-2 p-3 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-zinc-700">
                  <Icon.Warning /><span>{error}</span>
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <button onClick={onClose} className="px-4 py-2.5 border border-zinc-200 text-sm font-medium rounded-lg hover:bg-zinc-50">Annuler</button>
                <button
                  onClick={send}
                  disabled={!possible || sending || generating || !sujet.trim() || !corps.trim()}
                  className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sending ? <><Icon.Loader /> Envoi en cours...</> : <><Icon.Send /> Envoyer la relance</>}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
