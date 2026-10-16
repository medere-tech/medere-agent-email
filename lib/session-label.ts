// Libellés des sessions présentés au PS, calculés ici à partir des dates Airtable (jamais par le
// modèle de rédaction), et contrôle des couples « jour de la semaine + date » d'un texte rédigé.
// Fonctions pures, sans import (testables avec Node). Fuseau de référence : Europe/Paris.

const TZ = 'Europe/Paris'
const DAY = /^\d{4}-\d{2}-\d{2}/

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

// Horaire des classes virtuelles (aucun champ d'horaire dans Airtable)
export const CLASSE_VIRTUELLE_HORAIRE = 'en soirée à partir de 19h00'

export interface SessionDates {
  numero: string
  date_debut?: string
  date_fin?: string
  date_cv1?: string
  date_cv2?: string
}

export type SessionKind = 'classe_virtuelle' | 'presentiel' | 'elearning' | 'autre'

export function sessionKind(format: string | undefined | null): SessionKind {
  const f = String(format || '').toLowerCase()
  if (f.includes('virtuel')) return 'classe_virtuelle'
  if (f.includes('learning')) return 'elearning'
  if (f.includes('présentiel') || f.includes('presentiel')) return 'presentiel'
  return 'autre'
}

interface Parts { y: number; m: number; d: number; wd: number }

// Une date Airtable « AAAA-MM-JJ » est un jour du calendrier : lue à midi UTC puis exprimée à
// Paris, elle donne toujours le même jour, quel que soit le fuseau du serveur.
function parts(day: string): Parts | null {
  if (!DAY.test(String(day || ''))) return null
  const t = Date.parse(`${String(day).slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(t)) return null
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd }
}

const dayNum = (d: number) => (d === 1 ? '1er' : String(d))

// « mardi 13 octobre 2026 » (fuseau Europe/Paris) ; texte d'origine si la date est illisible
export function formatLongDate(day: string): string {
  const p = parts(day)
  if (!p) return String(day || '')
  return `${WEEKDAYS[p.wd]} ${dayNum(p.d)} ${MONTHS[p.m - 1]} ${p.y}`
}

// Plusieurs jours, mois et année factorisés : « mardi 13 et jeudi 15 octobre 2026 »,
// « mardi 29 septembre et jeudi 1er octobre 2026 », « mardi 29 décembre 2026 et lundi 4 janvier 2027 »
function joinDays(days: string[]): string {
  const ps = days.map(parts).filter((p): p is Parts => !!p)
  if (!ps.length) return ''
  const out: string[] = []
  ps.forEach((p, i) => {
    const next = ps[i + 1]
    let s = `${WEEKDAYS[p.wd]} ${dayNum(p.d)}`
    if (!next || next.m !== p.m || next.y !== p.y) s += ` ${MONTHS[p.m - 1]}`
    if (!next || next.y !== p.y) s += ` ${p.y}`
    out.push(s)
  })
  return out.length === 1 ? out[0] : `${out.slice(0, -1).join(', ')} et ${out[out.length - 1]}`
}

const uniq = (xs: (string | undefined)[]) =>
  Array.from(new Set(xs.map((x) => String(x || '').slice(0, 10)).filter((x) => DAY.test(x)))).sort()

// Dates d'une session telles que présentées au PS :
//   classe virtuelle : 1ère et 2ème soirée (jamais la date de début si elles diffèrent), horaire du soir
//   présentiel       : date(s) du présentiel (date de début seulement à défaut)
//   e-learning       : du début à la fin de la session
export function sessionDatesText(s: SessionDates, format: string): string {
  const kind = sessionKind(format)
  if (kind === 'elearning') {
    const debut = parts(s.date_debut || '') ? formatLongDate(s.date_debut!) : ''
    const fin = parts(s.date_fin || '') ? formatLongDate(s.date_fin!) : ''
    if (debut && fin) return `du ${debut} au ${fin}`
    if (debut) return `à partir du ${debut}`
    return fin ? `jusqu'au ${fin}` : ''
  }
  let days = uniq([s.date_cv1, s.date_cv2])
  if (!days.length) days = uniq([s.date_debut])
  const text = joinDays(days)
  if (!text) return ''
  return kind === 'classe_virtuelle' ? `${text}, ${CLASSE_VIRTUELLE_HORAIRE}` : text
}

// « Session 26.010 : mardi 13 et jeudi 15 octobre 2026, en soirée à partir de 19h00 »
export function sessionLabel(s: SessionDates, format: string): string {
  const dates = sessionDatesText(s, format)
  return dates ? `Session ${s.numero} : ${dates}` : `Session ${s.numero}`
}

export function sessionLabels(sessions: SessionDates[], format: string): string {
  return sessions.map((s) => sessionLabel(s, format)).join('\n')
}

// ─── Contrôle après rédaction ─────────────────────────────────────────────────

export interface DateWarning { extrait: string; message: string }

// Minuscules sans accents, caractère par caractère : même longueur que le texte d'origine
// (les positions trouvées dans le texte replié servent à citer l'extrait d'origine)
const fold = (s: string) => Array.from(s, (c) => { const x = c.length === 1 ? c.normalize("NFD")[0] : c; const l = x.toLowerCase(); return l.length === x.length ? l : x }).join("")
const MONTHS_FOLDED = MONTHS.map(fold)
const WD_RE = /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(1er|\d{1,2})(?![\d/])/gi
// Mois (et année) qui suivent un « jour + numéro », sans franchir une fin de phrase ou de ligne :
// « mardi 13 et jeudi 15 octobre 2026 » rattache « mardi 13 » à octobre 2026.
const MONTH_AFTER = new RegExp(`^[^\\n.;:()]{0,60}?\\b(${MONTHS_FOLDED.join('|')})\\b(?:\\s+(\\d{4}))?`)

function weekdayOf(y: number, m: number, d: number): number | null {
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const p = parts(iso)
  return p && p.m === m && p.d === d ? p.wd : null
}

// Année d'une date écrite sans année : la prochaine occurrence, en tolérant 60 jours de passé
function inferYear(m: number, d: number, today: string): number {
  const p = parts(today)!
  const t = Date.UTC(p.y, m - 1, d)
  return t >= Date.UTC(p.y, p.m - 1, p.d) - 60 * 86400000 ? p.y : p.y + 1
}

// Chaque « jour de la semaine + date » du texte doit correspondre au calendrier réel.
// today (AAAA-MM-JJ) ne sert qu'aux dates écrites sans année.
export function checkWeekdays(input: string, today?: string): DateWarning[] {
  const text = String(input || '')
  const folded = fold(text)
  const ref = today && DAY.test(today) ? today : new Date().toISOString().slice(0, 10)
  const out: DateWarning[] = []
  for (const m of Array.from(folded.matchAll(WD_RE))) {
    const start = m.index!
    const end = start + m[0].length
    const after = MONTH_AFTER.exec(folded.slice(end))
    if (!after) continue
    const month = MONTHS_FOLDED.indexOf(after[1]) + 1
    const d = m[2] === '1er' ? 1 : Number(m[2])
    const y = after[2] ? Number(after[2]) : inferYear(month, d, ref)
    const written = WEEKDAYS.indexOf(m[1])
    const real = weekdayOf(y, month, d)
    const extrait = text.slice(start, end + after[0].length).replace(/\s+/g, ' ').trim()
    if (real === null) {
      out.push({ extrait, message: `cette date n'existe pas (${dayNum(d)} ${MONTHS[month - 1]} ${y}).` })
    } else if (real !== written) {
      out.push({ extrait, message: `le ${dayNum(d)} ${MONTHS[month - 1]} ${y} est un ${WEEKDAYS[real]}, pas un ${WEEKDAYS[written]}.` })
    }
  }
  return out
}

// ─── Ouverture à l'inscription ────────────────────────────────────────────────

// Jour calendaire à Paris (AAAA-MM-JJ) d'un instant donné
export function parisDay(date: Date = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

export interface OpenableSession extends SessionDates {
  webflow_id?: string
}

const dayOf = (x: string | undefined) => (DAY.test(String(x || '')) ? String(x).slice(0, 10) : '')

// Premier jour de la session : plus ancienne des dates « début de session » et « 1ère soirée / présentiel »
export function sessionStartDay(s: SessionDates): string {
  return [dayOf(s.date_debut), dayOf(s.date_cv1)].filter(Boolean).sort()[0] || ''
}

// Règle unique d'ouverture à l'inscription (étape 3 de l'assistant et relance), today = AAAA-MM-JJ
// à Paris. Dans tous les cas : webflow_id présent (sinon doublon).
//   classe virtuelle, présentiel : on ne peut pas s'inscrire le jour même ; la plus ancienne des dates
//     « début de session » et « 1ère soirée / présentiel » doit être strictement postérieure à
//     aujourd'hui ; une session sans aucune date n'est pas proposée
//   e-learning (format contenant « e-learning ») et autres formats : règle d'avant, inchangée —
//     sans date de début : proposée ; e-learning : proposée tant que sa date de fin n'est pas
//     dépassée, même commencée ; autres formats : date de début aujourd'hui ou plus tard
export function sessionOuverte(s: OpenableSession, format: string, today: string): boolean {
  if (!s.webflow_id) return false
  const f = String(format || '').toLowerCase()
  if (f.includes('e-learning')) {
    if (!s.date_debut) return true
    const fin = dayOf(s.date_fin)
    return !fin || fin >= today
  }
  const kind = sessionKind(format)
  if (kind === 'classe_virtuelle' || kind === 'presentiel') {
    const start = sessionStartDay(s)
    return !!start && start > today
  }
  if (!s.date_debut) return true
  const debut = dayOf(s.date_debut)
  return !!debut && debut >= today
}

// ─── Sessions proposées dans une relance ──────────────────────────────────────

export type RelanceMode = 'origine' | 'remplacement' | 'inconnues' | 'aucune'

export const RELANCE_MESSAGES: Record<RelanceMode, string | null> = {
  origine: null,
  remplacement: 'Les sessions du premier mail sont passées : la relance propose les prochaines sessions disponibles.',
  inconnues: "Les sessions du premier mail n'ont pas pu être retrouvées : la relance propose les prochaines sessions disponibles.",
  aucune: 'Aucune session à venir pour cette formation : relance impossible pour le moment.',
}

export const RELANCE_MAX_SESSIONS = 3

// origine : numéros des sessions du mail d'origine (null ou vide = inconnus) ; ouvertes : sessions
// de la formation encore ouvertes à l'inscription (sessionOuverte).
//   - au moins une session d'origine encore ouverte → uniquement celles-là ;
//   - sinon, prochaines sessions ouvertes de la formation (3 au plus, de la plus proche à la plus lointaine) ;
//   - aucune session ouverte → aucune.
export function selectRelanceSessions<T extends SessionDates>(origine: string[] | null, ouvertes: T[]): { mode: RelanceMode; sessions: T[] } {
  const sorted = [...ouvertes].sort((a, b) => sessionStartDay(a).localeCompare(sessionStartDay(b)))
  if (!sorted.length) return { mode: 'aucune', sessions: [] }
  if (!origine || !origine.length) return { mode: 'inconnues', sessions: sorted.slice(0, RELANCE_MAX_SESSIONS) }
  const kept = sorted.filter((s) => origine.includes(String(s.numero)))
  if (kept.length) return { mode: 'origine', sessions: kept }
  return { mode: 'remplacement', sessions: sorted.slice(0, RELANCE_MAX_SESSIONS) }
}

// Numéros de session (parmi ceux de la formation) cités dans un texte : « 26.010 » isolé, jamais à
// l'intérieur d'un autre nombre (« 126.0105 »)
export function sessionNumbersIn(text: string, numeros: string[]): string[] {
  const t = String(text || '')
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return Array.from(new Set(numeros.map((n) => String(n || '').trim()).filter(Boolean)))
    .filter((n) => new RegExp(`(?<![\\d.])${esc(n)}(?!\\d|\\.\\d)`).test(t))
}

// ─── Dates de session déjà passées ────────────────────────────────────────────

const DATE_RE = new RegExp(`(?<![\\d/])(1er|\\d{1,2})\\s+(${MONTHS_FOLDED.join('|')})\\b(?:\\s+(\\d{4}))?`, 'g')
const NUM_DATE_RE = /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/g
const WD_BEFORE = '(?:(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\\s+)?$'
const FROM_RE = new RegExp(`\\bdu\\s+${WD_BEFORE}`)
const SINCE_RE = new RegExp(`a partir du\\s+${WD_BEFORE}`)
const pad = (n: number) => String(n).padStart(2, '0')

// Dates de session déjà passées (antérieures à today, AAAA-MM-JJ) écrites dans le texte. Une date
// est considérée comme une date de session si elle porte un jour de la semaine (les libellés de
// session en ont toujours) ou si sa ligne mentionne une session : la date du premier mail
// (« transmis les informations le 13 octobre ») n'est pas signalée. Le début d'une période
// (« du … au … », « à partir du … ») est ignoré : un e-learning commencé reste ouvert.
export function checkPastDates(input: string, today: string): DateWarning[] {
  const text = String(input || '')
  if (!DAY.test(today)) return []
  const folded = fold(text)
  const out: DateWarning[] = []
  const seen = new Set<number>()
  const lineAt = (pos: number) => {
    const a = folded.lastIndexOf('\n', pos - 1) + 1
    const b = folded.indexOf('\n', pos)
    return { start: a, text: folded.slice(a, b === -1 ? undefined : b) }
  }
  const isPeriodStart = (start: number, end: number) => {
    const before = folded.slice(lineAt(start).start, start)
    return SINCE_RE.test(before) || (FROM_RE.test(before) && /^[^\n]*?\bau\s+/.test(folded.slice(end)))
  }
  const push = (start: number, end: number, y: number, m: number, d: number, withWeekday: boolean) => {
    if (seen.has(start)) return
    seen.add(start)
    if (!withWeekday && !/\bsessions?\b/.test(lineAt(start).text)) return
    if (isPeriodStart(start, end) || weekdayOf(y, m, d) === null) return
    const iso = `${y}-${pad(m)}-${pad(d)}`
    if (iso >= today) return
    const extrait = text.slice(start, end).replace(/\s+/g, ' ').trim()
    // « mardi 13 et jeudi 15 octobre 2026 » : un seul avertissement pour la session (déjà cité)
    if (out.some((w) => w.extrait.endsWith(extrait))) return
    out.push({ extrait, message: `cette date est déjà passée (${formatLongDate(iso)}).` })
  }
  // « mardi 13 … octobre 2026 » (mois et année rattachés comme dans checkWeekdays)
  for (const m of Array.from(folded.matchAll(WD_RE))) {
    const start = m.index!
    const end = start + m[0].length
    const after = MONTH_AFTER.exec(folded.slice(end))
    if (!after) continue
    const month = MONTHS_FOLDED.indexOf(after[1]) + 1
    const d = m[2] === '1er' ? 1 : Number(m[2])
    const y = after[2] ? Number(after[2]) : inferYear(month, d, today)
    // Le numéro du jour (sans le jour de la semaine) ne doit pas être repris par DATE_RE
    seen.add(end - m[2].length)
    push(start, end + after[0].length, y, month, d, true)
  }
  // « 13 octobre 2026 » sans jour de la semaine
  for (const m of Array.from(folded.matchAll(DATE_RE))) {
    const month = MONTHS_FOLDED.indexOf(m[2]) + 1
    const d = m[1] === '1er' ? 1 : Number(m[1])
    push(m.index!, m.index! + m[0].length, m[3] ? Number(m[3]) : inferYear(month, d, today), month, d, false)
  }
  // « 13/10/2026 »
  for (const m of Array.from(folded.matchAll(NUM_DATE_RE))) {
    push(m.index!, m.index! + m[0].length, Number(m[3]), Number(m[2]), Number(m[1]), false)
  }
  return out
}

// Contrôle complet d'un texte rédigé (étape 5 et relance) : jours de la semaine incohérents, puis
// dates de session déjà passées (seulement si today est connu)
export function checkDates(input: string, today?: string): DateWarning[] {
  const weekdays = checkWeekdays(input, today)
  if (!today) return weekdays
  const flagged = new Set(weekdays.map((w) => w.extrait))
  return [...weekdays, ...checkPastDates(input, today).filter((w) => !flagged.has(w.extrait))]
}

// ─── Concordance avec le texte « Temps lisible (Webflow) » ────────────────────

const F_DEBUT = 'Date de début de session'
const F_CV1 = 'Date 1ère soirée CV / Date Présentiel'
const F_CV2 = 'Date 2ème soirée CV'

interface WebflowDates {
  extrait: string
  // jour : « 17 décembre 2026 », « 24 novembre et 1 décembre 2026 » ; mois : « Septembre 2026 » ;
  // annee : « Session 2026 »
  precision: 'jour' | 'mois' | 'annee'
  days: { d: number; m: number; y?: number }[]
  month?: number
  year?: number
}

const WEBFLOW_TOKEN_RE = new RegExp(`(?<!\\d)(\\d{4})(?!\\d)|(?<!\\d)(1er|\\d{1,2})(?!\\d)|\\b(${MONTHS_FOLDED.join('|')})\\b`, 'g')

// Dates du texte Webflow, lues dans l'ordre : un mois (puis une année) s'applique aux jours qui le
// précèdent. null si le texte ne contient aucune date.
function parseWebflowDates(input: string): WebflowDates | null {
  const text = String(input || '')
  const folded = fold(text)
  const days: { d: number; m?: number; y?: number }[] = []
  let month: number | undefined
  let year: number | undefined
  let start = -1
  let end = -1
  for (const t of Array.from(folded.matchAll(WEBFLOW_TOKEN_RE))) {
    if (t[1]) {
      const y = Number(t[1])
      days.forEach((x) => { if (x.y === undefined) x.y = y })
      if (year === undefined) year = y
    } else if (t[2]) {
      const d = t[2] === '1er' ? 1 : Number(t[2])
      if (d < 1 || d > 31) continue
      days.push({ d })
    } else {
      const m = MONTHS_FOLDED.indexOf(t[3]) + 1
      days.forEach((x) => { if (x.m === undefined) x.m = m })
      if (month === undefined) month = m
    }
    if (start === -1) start = t.index!
    end = t.index! + t[0].length
  }
  if (start === -1) return null
  const extrait = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const dated = days.filter((x): x is { d: number; m: number; y?: number } => x.m !== undefined)
  if (dated.length) return { extrait, precision: 'jour', days: dated }
  if (month !== undefined) return { extrait, precision: 'mois', days: [], month, year }
  if (year !== undefined) return { extrait, precision: 'annee', days: [], year }
  return null
}

// « 16 décembre », « 13 et 15 octobre », « 24 novembre et 1er décembre 2026 » (année si demandée)
function joinPlainDays(days: string[], withYear: boolean): string {
  const ps = days.map(parts).filter((p): p is Parts => !!p)
  const out = ps.map((p, i) => {
    const next = ps[i + 1]
    let s = dayNum(p.d)
    if (!next || next.m !== p.m || next.y !== p.y) s += ` ${MONTHS[p.m - 1]}`
    if (withYear && (!next || next.y !== p.y)) s += ` ${p.y}`
    return s
  })
  return out.length === 1 ? out[0] : `${out.slice(0, -1).join(', ')} et ${out[out.length - 1]}`
}

export interface WebflowDateCheck {
  site: string        // dates lues dans le texte Webflow (« 17 décembre 2026 »)
  mail: string        // dates du mail (« 16 décembre »)
  champs: string[]    // champs Airtable d'où vient la date du mail, à corriger si le site a raison
  message: string     // avertissement affiché (étape 3, étape 5, relance)
}

// La date écrite dans le mail (sessionDatesText) concorde-t-elle avec le texte « Temps lisible
// (Webflow) » affiché à l'étape 3 ? null si oui, ou si rien n'est comparable (texte ou fiche sans date).
//   texte au jour (« 17 décembre 2026 ») : mêmes jours que le mail (1ère et 2ème soirée, ou date du
//     présentiel, date de début à défaut ; e-learning : date de début) ;
//   texte au mois ou à l'année (« Septembre 2026 », « Session 2026 » : e-learning, hybride) : mois ou
//     année de la date de début de session.
export function webflowDateCheck(s: SessionDates & { temps_lisible?: string }, format: string): WebflowDateCheck | null {
  const w = parseWebflowDates(s.temps_lisible || '')
  if (!w) return null
  const make = (mail: string, champs: string[]): WebflowDateCheck => ({
    site: w.extrait, mail, champs,
    message: `Date à vérifier : le site indique « ${w.extrait} », le mail indiquera ${mail}. Préviens Maylis.`,
  })
  if (w.precision !== 'jour') {
    const debut = dayOf(s.date_debut)
    const p = parts(debut)
    if (!p) return null
    const ok = w.precision === 'mois' ? p.m === w.month && (w.year === undefined || p.y === w.year) : p.y === w.year
    return ok ? null : make(`un début de session le ${joinPlainDays([debut], true)}`, [F_DEBUT])
  }
  const elearning = sessionKind(format) === 'elearning'
  const cv = uniq([s.date_cv1, s.date_cv2])
  const fromCv = !elearning && cv.length > 0
  const mailDays = elearning ? uniq([s.date_debut]) : fromCv ? cv : uniq([s.date_debut])
  if (!mailDays.length) return null
  const refYear = Number(mailDays[0].slice(0, 4))
  const siteDays = Array.from(new Set(w.days.map((x) => `${x.y ?? refYear}-${pad(x.m)}-${pad(x.d)}`))).sort()
  if (siteDays.length === mailDays.length && siteDays.every((d, i) => d === mailDays[i])) return null
  let champs = [F_DEBUT]
  if (fromCv) {
    champs = []
    if (siteDays[0] !== dayOf(s.date_cv1)) champs.push(F_CV1)
    if ((siteDays[1] || '') !== dayOf(s.date_cv2)) champs.push(F_CV2)
    if (!champs.length) champs = [F_CV1]
  }
  const siteYears = new Set(w.days.map((x) => x.y ?? refYear))
  const withYear = mailDays.some((d) => !siteYears.has(Number(d.slice(0, 4))))
  return make(`${mailDays.length > 1 ? 'les' : 'le'} ${joinPlainDays(mailDays, withYear)}`, champs)
}
