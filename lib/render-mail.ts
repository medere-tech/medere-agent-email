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
