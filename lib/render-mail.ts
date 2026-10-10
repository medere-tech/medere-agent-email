// Rendu unique du corps d'un mail : texte saisi → HTML + texte brut. Fonction pure, sans import
// (utilisable côté serveur, dans le navigateur pour l'aperçu, et testable avec Node).
//   - le texte saisi est échappé (« < », « & »… ne cassent jamais le HTML) ;
//   - liens Markdown [texte](url) → <a href="url">texte</a> ;
//   - URL brutes (http://, https://, www.) → liens, jamais à l'intérieur d'un lien déjà créé ;
//   - la ponctuation finale (. , ; : ! ? » ") et une parenthèse fermante non appariée sont exclues de l'URL ;
//   - retours à la ligne → <br> ;
//   - version texte brut : [texte](url) → « texte (url) » (ou l'URL seule si le texte est l'URL).

export interface RenderedMail {
  html: string
  text: string
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const MARKDOWN_LINK = /\[([^\]\n]+)\]\(\s*((?:https?:\/\/|www\.)[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\s*\)/g
const RAW_URL = /(?:https?:\/\/|www\.)[^\s<>"]+/g
const TRAILING = /[.,;:!?»"'’]+$/

// Retire la ponctuation finale et une parenthèse fermante non appariée
export function trimUrl(raw: string): { url: string; rest: string } {
  let url = raw
  let rest = ''
  for (;;) {
    const m = url.match(TRAILING)
    if (m) {
      rest = m[0] + rest
      url = url.slice(0, -m[0].length)
      continue
    }
    if (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
      rest = ')' + rest
      url = url.slice(0, -1)
      continue
    }
    break
  }
  return { url, rest }
}

function href(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

function sameTarget(label: string, url: string): boolean {
  const norm = (s: string) => s.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase()
  return norm(label) === norm(url)
}

type Segment = { kind: 'text'; value: string } | { kind: 'link'; label: string; url: string }

// Découpe le texte en segments texte / lien (liens Markdown d'abord, puis URL brutes dans le texte restant)
export function segment(input: string): Segment[] {
  const out: Segment[] = []
  const pushRaw = (text: string) => {
    let last = 0
    for (const m of Array.from(text.matchAll(RAW_URL))) {
      const start = m.index ?? 0
      const { url, rest } = trimUrl(m[0])
      if (!url || url === 'www.') continue
      if (start > last) out.push({ kind: 'text', value: text.slice(last, start) })
      out.push({ kind: 'link', label: url, url })
      if (rest) out.push({ kind: 'text', value: rest })
      last = start + m[0].length
    }
    if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  }
  let last = 0
  for (const m of Array.from(input.matchAll(MARKDOWN_LINK))) {
    const start = m.index ?? 0
    if (start > last) pushRaw(input.slice(last, start))
    out.push({ kind: 'link', label: m[1], url: m[2] })
    last = start + m[0].length
  }
  if (last < input.length) pushRaw(input.slice(last))
  return out
}

export function renderMail(input: string): RenderedMail {
  const normalized = String(input || '').replace(/\r\n?/g, '\n')
  const segments = segment(normalized)
  const html = segments
    .map((s) => (s.kind === 'text'
      ? escapeHtml(s.value)
      : `<a href="${escapeHtml(href(s.url))}">${escapeHtml(s.label)}</a>`))
    .join('')
    .replace(/\n/g, '<br>')
  const text = segments
    .map((s) => (s.kind === 'text' ? s.value : sameTarget(s.label, s.url) ? s.url : `${s.label} (${s.url})`))
    .join('')
  return { html, text }
}

// ─── Avertissements sur les liens mal formés (aperçu, avant l'envoi) ─────────────
// Non bloquants : le commercial reste libre d'envoyer. Chaque avertissement cite l'extrait fautif.
export interface LinkWarning {
  extrait: string
  message: string
}

const MD_ANY = /\[([^\]\n]*)\]\(([^)\n]*)\)/g
const MD_UNCLOSED = /\[[^\]\n]+\]\([^)\n]*$/gm
const BRACKETS_ONLY = /\[([^\]\n]{1,60})\](?!\()/g
const BAD_PROTOCOL = /\b(?:h?t?tps?:\/(?!\/)|https?\/\/|https?:\\|htps?:\/\/|htp:\/\/|hhtps?:\/\/)[^\s<>"]*/gi

function cut(s: string): string {
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}

export function linkWarnings(input: string): LinkWarning[] {
  const text = String(input || '').replace(/\r\n?/g, '\n')
  const out: LinkWarning[] = []
  const add = (extrait: string, message: string) => {
    if (!out.some((w) => w.extrait === cut(extrait) && w.message === message)) out.push({ extrait: cut(extrait), message })
  }

  // Liens Markdown [texte](adresse)
  for (const m of Array.from(text.matchAll(MD_ANY))) {
    const [all, label, url] = m
    const u = url.trim()
    if (!label.trim()) add(all, 'Lien sans texte : le PS verra un lien vide.')
    if (!u) add(all, "Lien sans adresse : ajoute l'adresse entre les parenthèses.")
    else if (/\s/.test(u)) add(all, "Espace dans l'adresse du lien : le lien ne fonctionnera pas.")
    else if (!/^(?:https?:\/\/|www\.)/i.test(u)) add(all, "Adresse de lien incomplète : elle doit commencer par https:// ou www. Le texte s'affichera tel quel, sans lien.")
  }
  for (const m of Array.from(text.matchAll(MD_UNCLOSED))) add(m[0], 'Lien non fermé : il manque la parenthèse fermante.')
  for (const m of Array.from(text.matchAll(BRACKETS_ONLY))) {
    add(m[0], "Texte entre crochets sans adresse : lien à compléter ? Il s'affichera tel quel.")
  }

  // Adresses mal écrites (protocole)
  for (const m of Array.from(text.matchAll(BAD_PROTOCOL))) add(trimUrl(m[0]).url || m[0], "Adresse mal écrite : le début doit être exactement https:// (ou www.).")

  // Adresses sans extension (www.agencedpc, https://medere)
  for (const s of segment(text)) {
    if (s.kind !== 'link') continue
    // Déjà signalé dans un lien Markdown mal formé : pas de second avertissement
    if (out.some((w) => w.extrait.includes(s.url))) continue
    const host = s.url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0]
    const bare = host.replace(/^www\./i, '')
    if (!bare || !/\.[a-z]{2,}$/i.test(bare)) add(s.url, "Adresse incomplète : l'extension du site (.fr, .com…) semble manquer.")
  }
  return out
}
