// Lecture du mail rédigé par Claude, au fil de l'eau (affichage progressif) comme à la fin.
// Format demandé : première ligne « Objet : … », une ligne vide, puis le texte du mail.
// Fonction pure, sans import : utilisée par la route /api/generate et par le navigateur.

export interface ParsedMail {
  sujet: string
  corps: string
  // false tant que la ligne d'objet n'est pas terminée (rédaction en cours)
  sujetComplet: boolean
}

const SUBJECT_LINE = /^\s*(?:\*\*)?\s*(?:objet|sujet)\s*:\s*(?:\*\*)?\s*/i

export function parseGeneratedMail(raw: string): ParsedMail {
  const text = String(raw || '').replace(/\r\n?/g, '\n')
  const trimmed = text.trimStart()

  // Ancien format (JSON { sujet, corps }) : toléré si le modèle s'en sert encore
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed.slice(0, trimmed.lastIndexOf('}') + 1))
      if (typeof j.sujet === 'string' && typeof j.corps === 'string') return { sujet: j.sujet.trim(), corps: j.corps.trim(), sujetComplet: true }
    } catch {
      // JSON incomplet (en cours de rédaction) : rien à afficher pour l'instant
    }
    return { sujet: '', corps: '', sujetComplet: false }
  }

  const nl = trimmed.indexOf('\n')
  const firstLine = nl === -1 ? trimmed : trimmed.slice(0, nl)
  if (SUBJECT_LINE.test(firstLine) || (nl === -1 && /^\s*(?:o|ob|obj|obje|objet|s|su|suj|suje|sujet)\s*$/i.test(firstLine))) {
    const sujet = firstLine.replace(SUBJECT_LINE, '').replace(/\*\*$/, '').trim()
    if (nl === -1) return { sujet, corps: '', sujetComplet: false }
    return { sujet, corps: trimmed.slice(nl + 1).replace(/^\s*\n/, '').replace(/\s+$/, ''), sujetComplet: true }
  }
  // Pas de ligne d'objet : tout est le texte du mail
  return { sujet: '', corps: trimmed.replace(/\s+$/, ''), sujetComplet: true }
}
