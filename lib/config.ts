// Constantes de configuration de l'app. Aucun import : ce fichier est aussi lu
// par les scripts Node (scripts/migrate-kv.ts).

// Rétention RGPD des envois dans le KV (email_track, index, compteurs) : 3 ans.
// Le cron quotidien purge les envois plus anciens ; les compteurs journaliers
// expirent d'eux-mêmes. Les Notes HubSpot ne sont pas concernées.
export const RETENTION_DAYS = 1095

// Le corps des mails (email_body:{id}) n'est gardé que pour pré-remplir une relance :
// 200 mails/jour × ~3 Ko × 3 ans dépasserait 600 Mo. Au-delà, le corps est relu chez Resend.
export const EMAIL_BODY_TTL_DAYS = 90

// Une ouverture ou un clic survenu moins de N secondes après la livraison (à défaut,
// l'envoi) est marqué « probablement automatique » (antivirus, proxy de messagerie) :
// stocké, mais exclu des taux, des Notes HubSpot et des notifications.
export const AUTO_EVENT_WINDOW_SECONDS = 60

// Délai de la relance J+3 (jours calendaires, heure de Paris).
export const RELANCE_DELAY_DAYS = 3

// Fuseau de référence des compteurs journaliers et des relances.
export const TIMEZONE = 'Europe/Paris'
