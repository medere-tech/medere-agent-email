/**
 * Tests de la règle d'ouverture des sessions (étape 3 et relance), du choix des sessions d'une
 * relance et du contrôle des dates de session passées (lib/session-label.ts). Aucun appel réseau,
 * aucun envoi. Sessions réelles relevées dans Airtable le 13 octobre 2026.
 *
 * Usage (Node ≥ 22.18) : node scripts/test-relance-sessions.ts        (exit 1 au premier écart)
 */
import { checkDates, checkPastDates, selectRelanceSessions, sessionNumbersIn, sessionOuverte, type OpenableSession } from '../lib/session-label.ts'

let failures = 0
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'OK ' : 'KO '} ${name}${ok ? '' : `\n     attendu : ${JSON.stringify(expected)}\n     obtenu  : ${JSON.stringify(actual)}`}`)
}

const CV = 'Classe virtuelle'
const PRES = 'Présentiel'
const EL = 'E-Learning'
const WF = 'webflow'

// « L'IA en santé pour les médecins (Classe virtuelle) » : sessions à venir au 13 octobre 2026
const IA: OpenableSession[] = [
  { numero: '26.007', date_debut: '2026-09-21', date_fin: '2026-09-22', date_cv1: '2026-09-21', date_cv2: '2026-09-22', webflow_id: WF },
  { numero: '26.010', date_debut: '2026-10-13', date_fin: '2026-10-15', date_cv1: '2026-10-13', date_cv2: '2026-10-15', webflow_id: WF },
  { numero: '26.011', date_debut: '2026-11-02', date_fin: '2026-11-04', date_cv1: '2026-11-02', date_cv2: '2026-11-04', webflow_id: WF },
  { numero: '26.012', date_debut: '2026-11-17', date_fin: '2026-11-19', date_cv1: '2026-11-17', date_cv2: '2026-11-19', webflow_id: WF },
  { numero: '26.013', date_debut: '2026-12-01', date_fin: '2026-12-10', date_cv1: '2026-12-01', date_cv2: '2026-12-10', webflow_id: WF },
]
const ia = (n: string) => IA.find((s) => s.numero === n)!
// « Les préparations verticales… (Présentiel) » 26.003 : début (16/12) avant la date du présentiel (17/12)
const VERTIPREP: OpenableSession = { numero: '26.003', date_debut: '2026-12-16', date_fin: '2026-12-17', date_cv1: '2026-12-17', webflow_id: WF }
// « COVID long (E-learning) »
const COVID_036: OpenableSession = { numero: '26.036', date_debut: '2026-09-01', date_fin: '2027-01-15', webflow_id: WF }
const COVID_037: OpenableSession = { numero: '26.037', date_debut: '2026-09-07', date_fin: '2027-06-15', webflow_id: WF }
const COVID_038: OpenableSession = { numero: '26.038', date_debut: '2026-10-01', date_fin: '2027-04-15', webflow_id: WF }

// ─── Ouverture à l'inscription ────────────────────────────────────────────────
// Classe virtuelle et présentiel : premier jour strictement postérieur à aujourd'hui
eq("CV qui commence aujourd'hui (26.010 le 13/10) : non proposée", sessionOuverte(ia('26.010'), CV, '2026-10-13'), false)
eq('CV qui commence demain (26.010 le 12/10) : proposée', sessionOuverte(ia('26.010'), CV, '2026-10-12'), true)
eq('CV qui commence demain (26.011 le 01/11) : proposée', sessionOuverte(ia('26.011'), CV, '2026-11-01'), true)
eq("CV qui commence aujourd'hui (26.011 le 02/11) : non proposée", sessionOuverte(ia('26.011'), CV, '2026-11-02'), false)
eq('CV passée (26.007 le 13/10) : non proposée', sessionOuverte(ia('26.007'), CV, '2026-10-13'), false)
eq('Début (16/12) avant le présentiel (17/12), le 16/12 : non proposée', sessionOuverte(VERTIPREP, PRES, '2026-12-16'), false)
eq('Début (16/12) avant le présentiel (17/12), le 15/12 : proposée', sessionOuverte(VERTIPREP, PRES, '2026-12-15'), true)
eq('Présentiel sans date de début, présentiel à venir : proposé', sessionOuverte({ numero: 'X', date_cv1: '2026-12-17', webflow_id: WF }, PRES, '2026-10-13'), true)
eq('CV sans aucune date : non proposée', sessionOuverte({ numero: 'X', webflow_id: WF }, CV, '2026-10-13'), false)
eq('Présentiel sans aucune date : non proposé', sessionOuverte({ numero: 'X', webflow_id: WF }, PRES, '2026-10-13'), false)
eq('Sans webflow_id : non proposée', sessionOuverte({ ...ia('26.011'), webflow_id: '' }, CV, '2026-10-13'), false)
// E-learning : règle d'avant ce chantier, inchangée
eq('E-learning commencé hier (26.038 le 02/10) : proposé', sessionOuverte(COVID_038, EL, '2026-10-02'), true)
eq('E-learning en cours (26.036 le 13/10) : proposé', sessionOuverte(COVID_036, EL, '2026-10-13'), true)
eq('E-learning en cours (26.037 le 13/10) : proposé', sessionOuverte(COVID_037, EL, '2026-10-13'), true)
eq('E-learning, dernier jour (26.038 le 15/04/2027) : proposé', sessionOuverte(COVID_038, EL, '2027-04-15'), true)
eq('E-learning terminé (26.038 le 16/04/2027) : non proposé', sessionOuverte(COVID_038, EL, '2027-04-16'), false)
eq('E-learning sans aucune date : proposé (comme avant)', sessionOuverte({ numero: 'X', webflow_id: WF }, EL, '2026-10-13'), true)
eq('E-learning sans date de début, fin passée : proposé (comme avant)', sessionOuverte({ numero: 'X', date_fin: '2026-01-01', webflow_id: WF }, EL, '2026-10-13'), true)
eq('E-learning sans date de fin : proposé', sessionOuverte({ numero: 'X', date_debut: '2026-01-01', webflow_id: WF }, EL, '2026-10-13'), true)
eq('E-learning sans webflow_id : non proposé', sessionOuverte({ ...COVID_038, webflow_id: '' }, EL, '2026-10-13'), false)
// Autres formats (« Hybride ») : règle d'avant, inchangée (date de début aujourd'hui ou après ; sans date de début : proposée)
eq("Hybride qui commence aujourd'hui : proposé (comme avant)", sessionOuverte({ numero: 'X', date_debut: '2026-10-13', date_cv1: '2026-12-22', webflow_id: WF }, 'Hybride', '2026-10-13'), true)
eq('Hybride commencé hier : non proposé (comme avant)', sessionOuverte({ numero: 'X', date_debut: '2026-10-12', date_cv1: '2026-12-22', webflow_id: WF }, 'Hybride', '2026-10-13'), false)
eq('Hybride sans date de début : proposé (comme avant)', sessionOuverte({ numero: 'X', webflow_id: WF }, 'Hybride', '2026-10-13'), true)

// ─── Sessions d'une relance ───────────────────────────────────────────────────
const ouvertes = (today: string) => IA.filter((s) => sessionOuverte(s, CV, today))
const nums = (r: { mode: string; sessions: { numero: string }[] }) => [r.mode, r.sessions.map((s) => s.numero)]
eq('Toutes les sessions d\'origine encore ouvertes', nums(selectRelanceSessions(['26.011', '26.012'], ouvertes('2026-10-16'))), ['origine', ['26.011', '26.012']])
eq('Certaines passées : seules les ouvertes', nums(selectRelanceSessions(['26.010', '26.011'], ouvertes('2026-10-16'))), ['origine', ['26.011']])
eq('Toutes passées : 3 prochaines de la formation', nums(selectRelanceSessions(['26.010'], ouvertes('2026-10-16'))), ['remplacement', ['26.011', '26.012', '26.013']])
eq('Sessions d\'origine inconnues : 3 prochaines', nums(selectRelanceSessions(null, ouvertes('2026-10-16'))), ['inconnues', ['26.011', '26.012', '26.013']])
eq('Aucune session à venir', nums(selectRelanceSessions(['26.013'], ouvertes('2026-12-05'))), ['aucune', []])
eq('Remplacement trié de la plus proche à la plus lointaine', nums(selectRelanceSessions(['26.007'], [ia('26.013'), ia('26.011'), ia('26.012')])), ['remplacement', ['26.011', '26.012', '26.013']])

// ─── Numéros de session cités ─────────────────────────────────────────────────
const numeros = IA.map((s) => s.numero)
eq('Numéros cités', sessionNumbersIn('Session 26.010 : mardi…\nSession 26.012 : mardi…', numeros), ['26.010', '26.012'])
eq('Numéro inclus dans un autre nombre : ignoré', sessionNumbersIn('Réf. 126.0105 et 26.0111', numeros), [])
eq('Numéro en fin de phrase', sessionNumbersIn('Je vous propose la session 26.011.', numeros), ['26.011'])

// ─── Dates de session passées ─────────────────────────────────────────────────
const extraits = (t: string, today: string) => checkPastDates(t, today).map((w) => w.extrait)
eq('Libellé de session passée (26.010 au 16/10)', extraits('Session 26.010 : mardi 13 et jeudi 15 octobre 2026, en soirée à partir de 19h00', '2026-10-16'),
  ['mardi 13 et jeudi 15 octobre 2026'])
eq('Libellé de session à venir : rien', extraits('Session 26.011 : lundi 2 et mercredi 4 novembre 2026, en soirée à partir de 19h00', '2026-10-16'), [])
eq('Date du premier mail (sans session ni jour) : rien', extraits("dont je vous ai transmis les informations le 13 octobre. Elle est prise en charge par l'ANDPC.", '2026-10-16'), [])
eq('Date passée sans jour, sur une ligne de session', extraits('Prochaine session le 13 octobre 2026.', '2026-10-16'), ['13 octobre 2026'])
eq('Date passée au format JJ/MM/AAAA, sur une ligne de session', extraits('Session du 13/10/2026', '2026-10-16'), ['13/10/2026'])
eq('E-learning commencé : début de période ignoré', extraits('Session 26.038 : du jeudi 1er octobre 2026 au jeudi 15 avril 2027', '2026-10-16'), [])
eq('E-learning terminé : fin de période signalée', extraits('Session 26.038 : du jeudi 1er octobre 2026 au jeudi 15 avril 2027', '2027-04-16'), ['jeudi 15 avril 2027'])
eq('Date sans année : année déduite (13 octobre, au 16/10)', extraits('Session 26.010 : mardi 13 octobre', '2026-10-16'), ['mardi 13 octobre'])
eq('Aujourd\'hui n\'est pas passé', extraits('Session : vendredi 16 octobre 2026', '2026-10-16'), [])
eq('checkDates : jour incohérent signalé une seule fois', checkDates('Session 26.010 : lundi 13 octobre 2026', '2026-10-16').map((w) => w.message),
  ['le 13 octobre 2026 est un mardi, pas un lundi.'])
eq('checkDates sans date du jour : jours de la semaine seulement', checkDates('Session 26.010 : mardi 13 octobre 2026').length, 0)

console.log(failures ? `\n${failures} écart(s)` : '\nTous les tests passent')
process.exit(failures ? 1 : 0)
