import { parisDay } from '@/lib/session-label'

// Date du jour (AAAA-MM-JJ, fuseau Europe/Paris) utilisée par le serveur pour décider quelles
// sessions sont encore ouvertes à l'inscription (étape 3 de l'assistant, relance) et pour contrôler
// les dates des textes rédigés.
//
// ─── Simulation de la date (développement local uniquement) ───────────────────
// DEV_TODAY=AAAA-MM-JJ remplace la date du jour, sans rien écrire nulle part. Mêmes garde-fous que
// DEV_FORCE_ROLE : active seulement si NODE_ENV vaut « development » (npm run dev) ET que VERCEL
// n'est pas défini ; npm run build / next start fixent NODE_ENV à « production », et VERCEL est
// toujours défini sur Vercel. Présente ailleurs, la variable est ignorée et une erreur journalisée.
const DAY = /^\d{4}-\d{2}-\d{2}$/
let devLogged = ''

export function devToday(): string | null {
  const value = String(process.env.DEV_TODAY || '').trim()
  if (!value) return null
  const log = (key: string, fn: () => void) => { if (devLogged !== key) { devLogged = key; fn() } }
  if (process.env.NODE_ENV !== 'development' || process.env.VERCEL) {
    log('refus', () => console.error('[CONFIG] DEV_TODAY présent hors développement local : variable ignorée. Retire-la de cet environnement.'))
    return null
  }
  if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) {
    log('inconnu', () => console.warn(`[CONFIG] DEV_TODAY illisible (${value}) : ignorée. Format attendu : AAAA-MM-JJ.`))
    return null
  }
  log(value, () => console.warn(`[CONFIG] MODE TEST (développement local) : date du jour simulée au ${value}.`))
  return value
}

export function today(): string {
  return devToday() || parisDay()
}
