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

// Administrateur : profil lu dans les variables d'environnement (aucun identifiant dans le code),
// indépendant de la table Commerciaux d'Airtable. Il a toujours l'accès complet, que sa fiche existe,
// soit « Plus actif » ou ait été supprimée. Il envoie en son nom (ce profil) ou au nom de n'importe
// quel commercial actif ; toute action faite au nom d'un autre commercial est tracée (sent_by dans
// le suivi, mention dans la Note HubSpot). Il relance n'importe quel mail et voit tout.
//   ADMIN_EMAIL, ADMIN_NAME, ADMIN_HUBSPOT_OWNER_ID, ADMIN_SLACK_USER_ID : obligatoires
//   ADMIN_PHONE : facultatif
// Une variable obligatoire manquante : rôle administrateur désactivé (avertissement journalisé).
export interface AdminProfile {
  email: string
  name: string
  hubspot_id: string
  slack_user_id: string
  phone: string
}

const ADMIN_REQUIRED = ['ADMIN_EMAIL', 'ADMIN_NAME', 'ADMIN_HUBSPOT_OWNER_ID', 'ADMIN_SLACK_USER_ID'] as const
let adminWarned = ''

export function adminProfile(): AdminProfile | null {
  const env = (name: string) => String(process.env[name] || '').trim()
  const missing = ADMIN_REQUIRED.filter((n) => !env(n))
  if (missing.length) {
    const key = missing.join(',')
    if (adminWarned !== key) {
      adminWarned = key
      console.warn(`[CONFIG] Rôle administrateur désactivé : variable(s) manquante(s) ${missing.join(', ')}`)
    }
    return null
  }
  return {
    email: env('ADMIN_EMAIL').toLowerCase(),
    name: env('ADMIN_NAME'),
    hubspot_id: env('ADMIN_HUBSPOT_OWNER_ID'),
    slack_user_id: env('ADMIN_SLACK_USER_ID'),
    phone: env('ADMIN_PHONE'),
  }
}

export function adminEmails(): string[] {
  const p = adminProfile()
  return p ? [p.email] : []
}

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

// Destinataire des alertes techniques (DM Slack) : erreurs du cron, Note HubSpot en échec définitif.
// C'est l'administrateur (ADMIN_SLACK_USER_ID) ; chaîne vide si le profil administrateur est incomplet.
export function alertSlackUserId(): string {
  return adminProfile()?.slack_user_id || ''
}

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
export const TRACKING_RELIABLE_SINCE: string | null = null
