/**
 * Tests des libellés de session et du contrôle « jour de la semaine + date » (lib/session-label.ts).
 * Aucun appel réseau, aucun envoi. Sessions réelles relevées dans Airtable le 13 octobre 2026.
 *
 * Usage (Node ≥ 22.18) : node scripts/test-session-dates.ts        (exit 1 au premier écart)
 */
import { checkWeekdays, formatLongDate, sessionLabel } from '../lib/session-label.ts'

let failures = 0
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${name}${ok ? '' : `\n     attendu : ${JSON.stringify(expected)}\n     obtenu  : ${JSON.stringify(actual)}`}`)
}

const CV = 'Classe virtuelle'
const PRES = 'Présentiel'
const EL = 'E-Learning'

// ─── Libellés (sessions réelles) ──────────────────────────────────────────────
const sessions: [string, Record<string, string>, string, string][] = [
  ["L'IA en santé (CV) 26.010", { numero: '26.010', date_debut: '2026-10-13', date_fin: '2026-10-15', date_cv1: '2026-10-13', date_cv2: '2026-10-15' }, CV,
    'Session 26.010 : mardi 13 et jeudi 15 octobre 2026, en soirée à partir de 19h00'],
  ["L'IA en santé (CV) 26.011", { numero: '26.011', date_debut: '2026-11-02', date_fin: '2026-11-04', date_cv1: '2026-11-02', date_cv2: '2026-11-04' }, CV,
    'Session 26.011 : lundi 2 et mercredi 4 novembre 2026, en soirée à partir de 19h00'],
  ["L'IA en santé (CV) 26.013", { numero: '26.013', date_debut: '2026-12-01', date_fin: '2026-12-10', date_cv1: '2026-12-01', date_cv2: '2026-12-10' }, CV,
    'Session 26.013 : mardi 1er et jeudi 10 décembre 2026, en soirée à partir de 19h00'],
  // Date de début (31 mai) différente de la 1ère soirée (1er juin) : les soirées priment
  ['CV 26.010 (début ≠ 1ère soirée)', { numero: '26.010', date_debut: '2026-05-31', date_fin: '2026-09-18', date_cv1: '2026-06-01', date_cv2: '2026-06-04' }, CV,
    'Session 26.010 : lundi 1er et jeudi 4 juin 2026, en soirée à partir de 19h00'],
  ["L'IA en santé (Présentiel) 26.004", { numero: '26.004', date_debut: '2026-12-17', date_fin: '2026-12-17', date_cv1: '2026-12-17' }, PRES,
    'Session 26.004 : jeudi 17 décembre 2026'],
  ["L'IA en santé (Présentiel) 26.003", { numero: '26.003', date_debut: '2026-11-18', date_fin: '2026-11-18', date_cv1: '2026-11-18' }, PRES,
    'Session 26.003 : mercredi 18 novembre 2026'],
  ['COVID long (E-learning) 26.038', { numero: '26.038', date_debut: '2026-10-01', date_fin: '2027-04-15' }, EL,
    'Session 26.038 : du jeudi 1er octobre 2026 au jeudi 15 avril 2027'],
  ['COVID long (E-learning) 26.037', { numero: '26.037', date_debut: '2026-09-07', date_fin: '2027-06-15' }, EL,
    'Session 26.037 : du lundi 7 septembre 2026 au mardi 15 juin 2027'],
  // Cas construits : soirées sur deux mois, sur deux années, une seule soirée
  ['CV sur deux mois', { numero: 'X1', date_cv1: '2026-09-29', date_cv2: '2026-10-01' }, CV,
    'Session X1 : mardi 29 septembre et jeudi 1er octobre 2026, en soirée à partir de 19h00'],
  ['CV sur deux années', { numero: 'X2', date_cv1: '2026-12-29', date_cv2: '2027-01-04' }, CV,
    'Session X2 : mardi 29 décembre 2026 et lundi 4 janvier 2027, en soirée à partir de 19h00'],
  ['CV une seule soirée', { numero: 'X3', date_debut: '2026-10-20', date_cv1: '2026-10-20' }, CV,
    'Session X3 : mardi 20 octobre 2026, en soirée à partir de 19h00'],
  ['Sans date', { numero: 'X4' }, PRES, 'Session X4'],
]
for (const [name, s, format, expected] of sessions) eq(`libellé — ${name}`, sessionLabel(s as any, format), expected)

// Changement d'heure (25 octobre 2026) et fuseau du serveur sans effet sur le jour
eq('formatLongDate — passage à l’heure d’hiver', formatLongDate('2026-10-25'), 'dimanche 25 octobre 2026')
eq('formatLongDate — date illisible conservée', formatLongDate('Octobre 2026'), 'Octobre 2026')

// ─── Contrôle après rédaction ────────────────────────────────────────────────
const TODAY = '2026-10-13'
// Texte constaté en production
const prod = 'Session 26.010 : lundi 13 et mercredi 15 octobre 2026 (2ème soirée : jeudi 15 octobre 2026)'
eq('contrôle — mail de production', checkWeekdays(prod, TODAY), [
  { extrait: 'lundi 13 et mercredi 15 octobre 2026', message: 'le 13 octobre 2026 est un mardi, pas un lundi.' },
  { extrait: 'mercredi 15 octobre 2026', message: 'le 15 octobre 2026 est un jeudi, pas un mercredi.' },
])
// Tous les libellés calculés passent le contrôle
for (const [name, s, format] of sessions) eq(`contrôle — libellé correct (${name})`, checkWeekdays(sessionLabel(s as any, format), TODAY), [])
eq('contrôle — majuscule, accent, sans année (année déduite)', checkWeekdays('Rendez-vous Mardi 1er décembre à 19h.', TODAY), [])
eq('contrôle — sans année, faux', checkWeekdays('rendez-vous le vendredi 1er décembre', TODAY), [
  { extrait: 'vendredi 1er décembre', message: 'le 1er décembre 2026 est un mardi, pas un vendredi.' },
])
eq('contrôle — date inexistante', checkWeekdays('lundi 31 novembre 2026', TODAY), [
  { extrait: 'lundi 31 novembre 2026', message: "cette date n'existe pas (31 novembre 2026)." },
])
eq('contrôle — pas de mois proche : ignoré', checkWeekdays('Je vous rappelle jeudi 15. En octobre, la formation…', TODAY), [])
eq('contrôle — texte sans date', checkWeekdays('Bonjour Docteur, voici les étapes.', TODAY), [])

console.log(failures ? `\n${failures} écart(s).` : '\nTous les tests passent.')
process.exit(failures ? 1 : 0)
