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
