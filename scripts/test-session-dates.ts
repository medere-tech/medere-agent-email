/**
 * Tests des libellés de session, du contrôle « jour de la semaine + date » et de la concordance avec le
 * texte « Temps lisible (Webflow) » (lib/session-label.ts).
 * Aucun appel réseau, aucun envoi. Sessions réelles relevées dans Airtable le 13 octobre 2026.
 *
 * Usage (Node ≥ 22.18) : node scripts/test-session-dates.ts        (exit 1 au premier écart)
 */
import { checkWeekdays, formatLongDate, sessionLabel, webflowDateCheck } from '../lib/session-label.ts'

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

// ─── Concordance avec le texte « Temps lisible (Webflow) » (sessions réelles du 16 octobre 2026) ──
const HYB = 'Hybride'
const wf = (s: Record<string, string>, format: string) => webflowDateCheck(s as any, format)
eq('webflow — présentiel 26.002 (site 17/12, fiche 16/12)', wf({ numero: '26.002', date_debut: '2026-12-16', date_fin: '2027-03-31', date_cv1: '2026-12-16', temps_lisible: '17 décembre 2026 - Rencontres Médéré Paris' }, PRES), {
  site: '17 décembre 2026', mail: 'le 16 décembre', champs: ['Date 1ère soirée CV / Date Présentiel'],
  message: 'Date à vérifier : le site indique « 17 décembre 2026 », le mail indiquera le 16 décembre. Préviens Maylis.',
})
eq('webflow — présentiel concordant (début 16/12, présentiel 17/12)', wf({ numero: '26.003', date_debut: '2026-12-16', date_cv1: '2026-12-17', temps_lisible: '17 décembre 2026 - Rencontres Médéré Paris' }, PRES), null)
eq("webflow — CV L'IA en santé 26.011 concordante", wf({ numero: '26.011', date_debut: '2026-11-02', date_cv1: '2026-11-02', date_cv2: '2026-11-04', temps_lisible: '2 et 4 novembre 2026' }, CV), null)
eq('webflow — CV « 1 décembre » (sans « er ») concordante', wf({ numero: '26.013', date_debut: '2026-12-01', date_cv1: '2026-12-01', date_cv2: '2026-12-10', temps_lisible: '1 et 10 décembre 2026' }, CV), null)
eq('webflow — CV sur deux mois concordante', wf({ numero: '26.026', date_debut: '2026-11-24', date_cv1: '2026-11-24', date_cv2: '2026-12-01', temps_lisible: '24 novembre et 1 décembre 2026' }, CV), null)
eq('webflow — CV, 2ème soirée différente', wf({ numero: '26.011', date_debut: '2026-11-02', date_cv1: '2026-11-02', date_cv2: '2026-11-05', temps_lisible: '2 et 4 novembre 2026' }, CV), {
  site: '2 et 4 novembre 2026', mail: 'les 2 et 5 novembre', champs: ['Date 2ème soirée CV'],
  message: 'Date à vérifier : le site indique « 2 et 4 novembre 2026 », le mail indiquera les 2 et 5 novembre. Préviens Maylis.',
})
eq('webflow — CV, une seule soirée sur le site, deux dans la fiche', wf({ numero: '26.001', date_debut: '2026-10-28', date_cv1: '2026-10-28', date_cv2: '2026-11-04', temps_lisible: '28 octobre 2026' }, CV)?.champs, ['Date 2ème soirée CV'])
eq('webflow — CV, autre année', wf({ numero: '26.010', date_debut: '2026-12-21', date_cv1: '2026-12-21', temps_lisible: '21 décembre 2027' }, CV)?.mail, 'le 21 décembre 2026')
eq('webflow — e-learning « Septembre 2026 », début 7/09 : aucune alerte', wf({ numero: '26.010', date_debut: '2026-09-07', date_fin: '2027-06-15', temps_lisible: 'Septembre 2026' }, EL), null)
eq('webflow — e-learning « Session 2026 » : aucune alerte', wf({ numero: '26.001', date_debut: '2026-02-01', date_fin: '2026-12-31', temps_lisible: 'Session 2026' }, EL), null)
eq('webflow — e-learning « Août 2026 », début 1/08 : aucune alerte', wf({ numero: '26.007', date_debut: '2026-08-01', date_fin: '2027-01-15', temps_lisible: 'Août 2026' }, EL), null)
eq('webflow — hybride « Septembre 2026 », début 1/09 : aucune alerte', wf({ numero: '26.021', date_debut: '2026-09-01', date_fin: '2026-12-22', date_cv1: '2026-12-22', temps_lisible: 'Septembre 2026' }, HYB), null)
eq('webflow — e-learning, mois différent', wf({ numero: '26.011', date_debut: '2026-10-01', date_fin: '2027-04-15', temps_lisible: 'Septembre 2026' }, EL), {
  site: 'Septembre 2026', mail: 'un début de session le 1er octobre 2026', champs: ['Date de début de session'],
  message: 'Date à vérifier : le site indique « Septembre 2026 », le mail indiquera un début de session le 1er octobre 2026. Préviens Maylis.',
})
eq('webflow — texte vide ou sans date : aucune alerte', [wf({ numero: '1', date_debut: '2026-12-16', temps_lisible: '' }, PRES), wf({ numero: '1', date_debut: '2026-12-16', temps_lisible: 'Rencontres Médéré Paris' }, PRES)], [null, null])
eq('webflow — fiche sans date : aucune alerte', wf({ numero: '1', temps_lisible: '17 décembre 2026' }, PRES), null)

console.log(failures ? `\n${failures} écart(s).` : '\nTous les tests passent.')
process.exit(failures ? 1 : 0)
