// Constantes de configuration de l'app. Aucun import : ce fichier est aussi lu
// par les scripts Node (scripts/migrate-kv.ts).

// Rétention RGPD des envois dans le KV (email_track, index, compteurs) : 3 ans.
// Le cron quotidien purge les envois plus anciens ; les compteurs journaliers
// expirent d'eux-mêmes. Les Notes HubSpot ne sont pas concernées.
export const RETENTION_DAYS = 1095

// Le corps des mails (email_body:{id}) n'est plus stocké (minimisation RGPD : plus aucun usage depuis
// que la relance ne recopie plus le mail d'origine). Les clés existantes expirent seules (90 jours
// au plus) ; la purge et les scripts continuent de les supprimer tant qu'il peut en rester.

// Ouvertures et clics automatiques (antivirus, filtres de sécurité). Par défaut, toute
// ouverture et tout clic est humain : un PS qui ouvre le mail pendant l'appel est notre
// meilleur signal. Les ouvertures sont toujours humaines (Resend ne fournit ni navigateur
// ni adresse IP pour email.opened). Un clic n'est classé automatique que si :
//   - « rafale » : un autre lien du même mail a été cliqué à moins de CLICK_BURST_SECONDS
//     (d'après l'heure réelle du clic) — tous les clics de la rafale sont automatiques ;
//   - « robot » : le navigateur du clic est vide ou contient une de ces signatures.
// Un clic automatique est stocké, mais exclu des taux, des Notes HubSpot et des notifications.
// Ni l'adresse IP ni le navigateur ne sont conservés : seulement le classement et sa raison.
export const CLICK_BURST_SECONDS = 2
export const BOT_USER_AGENTS = [
  'bot', 'crawler', 'spider', 'curl', 'wget', 'python-requests', 'go-http-client',
  'headlesschrome', 'barracuda', 'mimecast', 'proofpoint',
]

// Délai avant de créer la Note HubSpot (et la notification) d'un premier clic : laisse
// arriver les autres clics d'une éventuelle rafale, qui le reclasseraient en automatique.
export const FIRST_CLICK_CONFIRM_DELAY_MS = 3000

// Historique des clics d'un mail (email_clicks:{id}), utile à la détection des rafales.
export const CLICK_HISTORY_MAX = 20
export const CLICK_HISTORY_TTL_DAYS = 7

// Délai de la relance J+3 (jours calendaires, heure de Paris).
export const RELANCE_DELAY_DAYS = 3

// Fuseau de référence des compteurs journaliers et des relances.
export const TIMEZONE = 'Europe/Paris'

// Administrateurs : peuvent choisir n'importe quel commercial actif à l'étape 1, relancer
// n'importe quel mail et tout voir. Toute action faite au nom d'un autre commercial est tracée
// (sent_by dans le suivi, mention dans la Note HubSpot).
export const ADMIN_EMAILS = ['dethie@medere.fr']

// Fiches Commerciaux : dernière version connue servie sans attente, rafraîchie en arrière-plan
// quand elle a plus de N secondes (délai maximal de révocation : voir README « Rôles et accès »).
export const COMMERCIAL_CACHE_SECONDS = 60

// Limites de débit par personne connectée (fenêtre fixe)
export const RATE_LIMITS = {
  generate: { max: 30, windowSeconds: 600 },
  send: { max: 20, windowSeconds: 600 },
} as const

// Formations et sessions : dernière version connue (mémoire, puis KV), rafraîchie en arrière-plan
// quand elle a plus de N secondes
export const AIRTABLE_CACHE_SECONDS = 300

// Destinataire des alertes techniques (DM Slack) : erreurs du cron, Note HubSpot en échec définitif
export const ALERT_SLACK_USER_ID = 'U05UVHGBURX'

// Notes HubSpot en échec : nouvel essai par le cron toutes les N heures, alerte après le dernier essai
export const HUBSPOT_RETRY_DELAY_HOURS = 6
export const HUBSPOT_RETRY_MAX_ATTEMPTS = 4

// Relance J+3 par DM Slack : nombre d'essais si Slack échoue (un par passage du cron)
export const SLACK_RELANCE_MAX_ATTEMPTS = 3

// Modèle de rédaction (mail initial et relance). Pour en changer et comparer : voir README
// « Modèle de rédaction ». Comparaison du 8 octobre 2026 : docs/comparaison-modeles.md
export const REDACTION_MODEL = 'claude-opus-4-6'

// Alerte « déjà contacté » à l'étape 4 : envois au même contact sur les N derniers jours
export const CONTACT_HISTORY_DAYS = 14

// Date (AAAA-MM-JJ) à partir de laquelle les ouvertures sont fiables (copie du commercial séparée,
// clics automatiques écartés). À renseigner le jour du déploiement. Pour une période qui commence
// avant cette date, /suivi affiche : « Taux d'ouverture antérieurs au JJ/MM/AAAA surestimés (copie
// commerciale comptée). » null = pas encore renseignée, aucun avertissement.
export const TRACKING_RELIABLE_SINCE: string | null = '2026-10-10'
