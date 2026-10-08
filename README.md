# Agent Mail DPC — Médéré

Application interne de génération et d'envoi de mails personnalisés pour les commerciaux Médéré.

Créé par [Déthié](https://dethie.fr/blog/) · Copyright © 2026 Médéré · Tous droits réservés

---

## Table des matières

1. [Présentation](#présentation)
2. [Stack technique](#stack-technique)
3. [Architecture du projet](#architecture-du-projet)
4. [Variables d'environnement](#variables-denvironnement)
5. [Fonctionnement détaillé](#fonctionnement-détaillé)
6. [Authentification](#authentification)
7. [Airtable — Formations et Sessions](#airtable--formations-et-sessions)
8. [Envoi des mails — idempotence et copie commerciale](#envoi-des-mails--idempotence-et-copie-commerciale)
9. [Relances automatiques J+3](#relances-automatiques-j3)
10. [Suivi des envois et clés KV](#suivi-des-envois-et-clés-kv)
11. [Webhooks Resend](#webhooks-resend)
12. [HubSpot — Logging des emails](#hubspot--logging-des-emails)
13. [Déploiement](#déploiement)
14. [Tests](#tests)
15. [Maintenance](#maintenance)
16. [Résolution de problèmes fréquents](#résolution-de-problèmes-fréquents)

---

## Présentation

L'Agent Mail DPC permet aux commerciaux Médéré de générer et envoyer un mail personnalisé à un professionnel de santé (PS) en moins de 60 secondes.

**Workflow commercial :**
1. Le PS appelle → le commercial identifie la formation et la session
2. Le commercial ouvre l'app, sélectionne son nom, la formation, les sessions, et le contact HubSpot du PS
3. Claude (IA) génère un mail personnalisé
4. Le commercial valide et envoie
5. Le mail est loggué sur HubSpot (Note sur la fiche contact du PS) ; le commercial reçoit une copie séparée
6. Une relance automatique est envoyée au commercial par DM Slack J+3 si le PS ne s'est pas inscrit

---

## Stack technique

| Outil | Usage |
|-------|-------|
| Next.js 14 (App Router) | Framework principal |
| TypeScript | Langage |
| Tailwind CSS | Styles |
| Vercel | Hébergement + Cron Jobs |
| Airtable | Base de données formations, sessions, commerciaux, inscriptions |
| HubSpot | CRM — recherche contacts PS + Notes |
| Resend | Envoi des emails + webhooks d'ouverture/clic |
| Upstash KV (Redis) via `@upstash/redis` | Tracking des emails, compteurs journaliers, index, relances J+3, idempotence, dédoublonnage des webhooks |
| Claude (Anthropic) | Génération des mails personnalisés |
| Slack | Notifications relances J+3 aux commerciaux |
| Google OAuth 2.0 | Authentification (comptes @medere.fr) |
| jose | Signature et vérification JWT sessions |

---

## Architecture du projet

```
medere-agent-email/
├── app/
│   ├── page.tsx                          # Page principale (Agent Mail)
│   ├── login/
│   │   └── page.tsx                      # Page de connexion Google OAuth
│   ├── suivi/
│   │   └── page.tsx                      # Page suivi des envois
│   └── api/
│       ├── auth/
│       │   ├── callback/google/route.ts  # Callback OAuth Google (GET)
│       │   └── logout/route.ts           # Déconnexion (POST uniquement)
│       ├── commerciaux/route.ts          # Liste des commerciaux actifs
│       ├── formations/route.ts           # Liste des formations actives
│       ├── sessions/route.ts             # Sessions par formation
│       ├── contact-search/route.ts       # Recherche contacts HubSpot (502 si HubSpot indisponible)
│       ├── generate/route.ts             # Génération mail via Claude (+ upsell)
│       ├── send/route.ts                 # Envoi via Resend, tracking KV, Note HubSpot, relance
│       ├── suivi/route.ts                # API lecture KV pour page suivi
│       ├── cron/
│       │   └── relance/route.ts          # Cron job relances J+3
│       └── webhooks/
│           └── resend/route.ts           # Webhooks tracking email (ouvert/cliqué)
├── components/
│   └── AgentMail.tsx                     # Composant principal (6 étapes)
├── lib/
│   ├── airtable.ts                       # Fonctions Airtable
│   ├── auth.ts                           # Session JWT (cookie)
│   ├── claude.ts                         # Génération mail IA
│   ├── config.ts                         # Constantes (RETENTION_DAYS, seuil des événements automatiques…)
│   ├── hubspot.ts                        # Recherche contacts + Notes HubSpot
│   ├── kv.ts                             # Client Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN)
│   ├── kv-schema.ts                      # Noms de clés KV, jours, scripts Lua atomiques (sans import)
│   └── tracking.ts                       # Enregistrement des envois, événements webhook, stats, purge RGPD
├── docs/
│   └── TESTS.md                          # Protocole de test complet
├── scripts/
│   ├── dedupe-hubspot-notes.ts           # Archive les Notes HubSpot ouvert / cliqué en double
│   ├── migrate-kv.ts                     # Export / migration v2 / vérification / restauration des données KV
│   ├── purge-test-sends.ts               # Supprime du KV les envois au PS de test
│   └── seed-test.ts                      # Crée / supprime les données de test (base KV de test)
├── backups/                              # Exports KV (migrate-kv.ts --export) — ignoré par git
├── middleware.ts                         # Protection des routes + CVE-2025-29927
├── vercel.json                           # Configuration cron Vercel
└── .env.local                            # Variables d'environnement (local, non versionné)
```

---

## Variables d'environnement

### Toutes les variables requises

| Variable | Description | Où la trouver |
|----------|-------------|---------------|
| `AIRTABLE_BASE_ID` | ID de la base Airtable | Airtable → API docs |
| `AIRTABLE_TOKEN` | Token API Airtable | Airtable → Account → API |
| `HUBSPOT_TOKEN` | Token Private App HubSpot | HubSpot → Settings → Integrations → Private Apps |
| `ANTHROPIC_API_KEY` | Clé API Claude | console.anthropic.com |
| `RESEND_API_KEY` | Clé API Resend | resend.com → API Keys |
| `RESEND_FROM_DOMAIN` | Domaine d'envoi (défaut `medere.fr`) | `medere.fr` |
| `RESEND_WEBHOOK_SECRET` | Secret webhook Resend | resend.com → Webhooks |
| `SLACK_BOT_TOKEN` | Token bot Slack | api.slack.com → OAuth & Permissions |
| `KV_REST_API_URL` | URL Upstash KV | Vercel → Storage → KV |
| `KV_REST_API_TOKEN` | Token Upstash KV | Vercel → Storage → KV |
| `CRON_SECRET` | Secret sécurisation cron — **obligatoire** : sans lui, le cron répond 500 | Générer aléatoirement |
| `GOOGLE_CLIENT_ID` | Client ID Google OAuth | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Secret Google OAuth | Google Cloud Console |
| `NEXTAUTH_SECRET` | Secret signature JWT sessions — **obligatoire** : sans lui, les pages protégées et le callback répondent 500 | Générer avec `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NEXTAUTH_URL` | URL de l'app (sert au `redirect_uri` OAuth) | `https://medere-agent-email-dpc.vercel.app` (prod) ou `http://localhost:3000` (local) |

> `NEXTAUTH_SECRET` et `NEXTAUTH_URL` gardent ce nom historique, mais l'app n'utilise pas la librairie next-auth.

### Tables Airtable

| Constante | ID |
|-----------|-----|
| Formations | `tblu6nfUIhTQ1cbgk` |
| Sessions | `tblGVEqH7KCo2GlXz` |
| Clients | `tbln6mEwZqHPXVylG` |
| Inscriptions | `tblTOJHEwCQhibcMM` |
| Commerciaux | `tblaDpXcgiNZfcJiO` |

---

## Fonctionnement détaillé

### Les 6 étapes du formulaire

**Étape 1 — Commercial**
Sélection du commercial parmi la liste Airtable (filtre `{Statut}="Actif"`).

**Étape 2 — Formation**
Sélection de la formation : formations `Active` avec numéro DPC (voir la constante `FORMATIONS_REQUIRE_FUTURE_SESSION` dans la section Airtable).

**Étape 3 — Sessions**
Sessions filtrées par :
- Liée à la formation sélectionnée
- `webflow_id` présent (évite les doublons)
- Date future — **sauf pour l'e-learning** : les sessions en cours (commencées mais pas terminées) sont incluses

**Étape 4 — Contact PS**
Recherche dans HubSpot par nom, prénom, email ou RPPS. Sélection du titre de politesse (Docteur / Madame / Monsieur).
Si HubSpot ne répond pas, l'app affiche « HubSpot indisponible, ne crée pas le contact » (et non « Aucun contact trouvé »), pour éviter de créer des doublons.

**Étape 5 — Aperçu**
Mail généré par Claude, modifiable avant envoi.

**Étape 6 — Confirmation**
Statuts : mail envoyé ✓, Note HubSpot sur la fiche du PS ✓, relance J+3 ✓.

Toute erreur d'API (Airtable, HubSpot, session expirée…) est affichée dans un bandeau rouge au lieu d'aboutir à une liste vide silencieuse.

---

## Authentification

### Technologie
Google OAuth 2.0 natif — aucune librairie d'auth. JWT signé avec `jose`.

### Flux
1. Utilisateur non connecté → redirigé vers `/login`
2. Clic "Se connecter avec Google" → Google OAuth
3. Vérification côté serveur que l'email est `@medere.fr` et vérifié
4. Cookie de session JWT créé (httpOnly, secure en production, 7 jours)
5. Middleware vérifie le cookie sur chaque requête

### Déconnexion
Bouton « Se déconnecter » dans le header de la page principale et de `/suivi`.
Il envoie un `POST /api/auth/logout` (un simple lien GET ne peut pas déconnecter), qui supprime le cookie et redirige vers `/login` (303).

### Durée de session
7 jours, pour l'expiration du JWT comme pour le `maxAge` du cookie. Modifiable dans `lib/auth.ts` :
```typescript
const SESSION_DURATION = 60 * 60 * 24 * 7 // 7 jours (JWT et maxAge du cookie)
```

> **La session n'est pas révocable.** Le JWT est autonome (aucune liste de sessions côté serveur) : il reste valide jusqu'à son expiration, même si le compte Google est désactivé entre-temps. Un compte désactivé garde donc l'accès à l'app **jusqu'à 7 jours** après sa dernière connexion. Seul le bouton « Se déconnecter » supprime le cookie, et uniquement sur le navigateur concerné.

### Sécurité
- Cookie `httpOnly` — inaccessible via JavaScript
- Cookie `secure` en production — HTTPS uniquement
- Vérification `@medere.fr` côté serveur (pas seulement côté Google)
- Protection CVE-2025-29927 dans `middleware.ts`
- JWT signé — impossible à falsifier sans `NEXTAUTH_SECRET`
- `NEXTAUTH_SECRET` absent → 500 explicite (log `[AUTH] NEXTAUTH_SECRET manquant`) au lieu d'une signature avec une clé vide

### Couper l'accès à un commercial
Désactiver son compte Google Workspace `@medere.fr` — il ne pourra plus se **reconnecter**, mais une session déjà ouverte n'est pas révocable : il **garde l'accès jusqu'à 7 jours** (expiration de son JWT). Pour une coupure immédiate de tous les accès, changer `NEXTAUTH_SECRET` sur Vercel et redéployer : toutes les sessions deviennent invalides et tous les utilisateurs doivent se reconnecter.

### Google Cloud Console
- Projet : `medere-agent-email`
- Type d'utilisateur : **Interne** (seuls les comptes @medere.fr autorisés)
- Redirect URI prod : `https://medere-agent-email-dpc.vercel.app/api/auth/callback/google`
- Redirect URI local : `http://localhost:3000/api/auth/callback/google`

---

## Airtable — Formations et Sessions

### Filtres formations (`getFormationsActives`)

Contrôlé par une constante en haut de `lib/airtable.ts` :

```typescript
export const FORMATIONS_REQUIRE_FUTURE_SESSION = false
```

- **`false` (actuel, recommandé par Maylis)** : `{Statut de la formation}="Active" AND {Numéro d'action DPC}!=""`. Toutes les formations actives avec numéro DPC apparaissent, qu'elles aient des sessions ou non.
- **`true`** : idem, mais uniquement les formations liées à au moins une session qui démarre après aujourd'hui (pas de filtre `webflow_id` à cette étape).

### Filtres sessions (`getSessionsByFormation`)

- Liée à la formation via `Numéro d'action DPC`
- `webflow_id` présent (évite les sessions en doublon)
- Date future **sauf e-learning** : les sessions dont la date de début est passée mais la date de fin est future sont incluses
- Pagination complète (toutes les pages Airtable chargées)

### Cache et pagination
- Toute requête **paginée** (formations, sessions, inscriptions, upsell) passe par `atAll()` et n'est **jamais** mise en cache (`cache: 'no-store'`), première page comprise. Une page 1 servie depuis le cache porterait un `offset` expiré et provoquerait `422 LIST_RECORDS_ITERATOR_NOT_AVAILABLE`.
- Les requêtes à une seule page (commerciaux, recherche Clients) gardent un cache de 60 s.
- Le cron lit toujours Airtable sans cache.

### Champs Airtable utilisés — Sessions

| Champ Airtable | Usage |
|----------------|-------|
| `session_id` | Identifiant unique session |
| `Numéro de session` | Affiché dans l'app |
| `Date de début de session` | Filtre sessions futures |
| `Date de fin de session` | Filtre e-learning en cours |
| `Date 1ère soirée CV / Date Présentiel` | Affiché dans l'app |
| `Date 2ème soirée CV` | Affiché dans l'app |
| `Date limite d'inscription` | Disponible mais non affiché |
| `Temps lisible (Webflow)` | Date affichée dans l'app |
| `Numéro d'action DPC` | Champ lié → IDs des records Formation |
| `webflow_id` | Filtre anti-doublon |
| `Format` (formation) | Détection e-learning |

---

## Envoi des mails — idempotence et copie commerciale

### Idempotence (pas de double envoi)
- Une clé d'idempotence (UUID) est générée côté client à l'arrivée à l'étape 5 et envoyée avec la requête `/api/send`. Elle est réutilisée pour tout renvoi du même mail (double clic, timeout) et régénérée à chaque nouveau mail.
- Elle est transmise à Resend (`idempotencyKey`) : un même envoi rejoué renvoie le même `email_id` sans nouveau mail. Un rejeu avec un contenu modifié est refusé (409 « déjà en cours d'envoi ou a déjà été envoyé »).
- Côté serveur, `email_track:{id}` est créé en `NX` : si la clé existe déjà, c'est un rejeu → la réponse du premier envoi (`send_result:{id}`) est renvoyée telle quelle, sans nouvelle Note, relance ni copie.
- Le bouton « Envoyer » est en plus verrouillé de façon synchrone contre le double clic.
- Seul l'appel Resend peut faire échouer la requête : une fois le mail parti, une erreur KV ou HubSpot est journalisée mais la réponse reste 200 (sinon le commercial renverrait un mail déjà reçu).

### Copie commerciale
- Le commercial n'est **pas** en BCC : la copie partagerait l'`email_id` (pixel + liens) et fausserait les ouvertures/clics du PS.
- La copie est un **envoi Resend séparé** à l'adresse du commercial (clé d'idempotence `<clé>-copie`), jamais enregistré dans le KV : ses ouvertures/clics sont ignorés par le webhook. Son échec n'empêche pas l'envoi au PS (log `[SEND] Copie commercial non envoyée`).

---

## Relances automatiques J+3

### Fonctionnement
À chaque envoi, la relance est planifiée dans le même script atomique que le tracking :
```
relances_due   (sorted set)  membre = resend_id, score = jour d'échéance J+3 (heure de Paris) à 00:00 UTC
email_track:{resend_id}      contient ce dont la relance a besoin : commercial_slack_id, ps_rpps, formation_numero, relance_due_day
```
Les anciennes clés `relance:{timestamp}` (avant la migration v2) sont reprises par `scripts/migrate-kv.ts` : rattachées à leur envoi quand c'est possible, sinon planifiées telles quelles (`legacy:relance:{timestamp}` dans `relances_due`).

> La lecture de `relances_due` par le cron (rattrapage, statut, lien vers la relance) arrive avec le lot 3 « Relances ». Le comportement décrit ci-dessous est celui du cron actuel, qui lit encore les clés `relance:*`.

Le cron Vercel tourne tous les jours à 8h UTC (`0 8 * * *`). Pour chaque clé `relance:*` dont `relance_at === aujourd'hui` :
1. Vérifie dans Airtable si le PS est déjà inscrit à une session de la formation (par RPPS ; sans RPPS, le RPPS est retrouvé via l'email dans la table Clients). Si oui → la clé est supprimée, pas de DM.
2. Sinon → DM Slack au commercial, puis suppression de la clé.
3. Si Airtable est indisponible, la relance part quand même (mieux vaut trop que pas assez) et l'erreur est remontée dans `errors[]` de la réponse et dans les logs.

### Configuration cron
Dans `vercel.json` :
```json
{
  "crons": [
    {
      "path": "/api/cron/relance",
      "schedule": "0 8 * * *"
    }
  ]
}
```
Le cron exige `Authorization: Bearer $CRON_SECRET` (ajouté automatiquement par Vercel). Sans `CRON_SECRET`, la route répond 500.

### Vérifier le cron
Vercel → projet → **Cron Jobs** dans le menu gauche → voir le dernier statut d'exécution. La réponse JSON contient `{ date, notified, purged, errors }` (`purged` : envois supprimés par la purge RGPD, voir plus bas).

---

## Suivi des envois et clés KV

Page accessible à `/suivi` — réservée aux utilisateurs connectés.

### Clés KV (schéma v2)

Les noms de clés et les scripts Lua sont centralisés dans `lib/kv-schema.ts`. Toute écriture qui touche plusieurs clés (envoi, événement webhook, migration) passe par un **script Lua atomique**.

| Clé | Type | Contenu | Expiration | Écrit par |
|-----|------|---------|------------|-----------|
| `email_track:{resend_id}` | JSON | Données de l'envoi (détail ci-dessous) | aucune — purge RGPD | `/api/send` (création NX), webhook, migration |
| `email_body:{resend_id}` | JSON | `{ corps }` du mail, pour pré-remplir une relance | 90 jours (`EMAIL_BODY_TTL_DAYS`) | `/api/send`, migration |
| `email_clicks:{resend_id}` | liste | 20 derniers clics : heure, lien, automatique ou non et raison (`rafale` / `robot`) — ni adresse IP ni navigateur | 7 jours (`CLICK_HISTORY_TTL_DAYS`) | webhook |
| `emails_index` | sorted set | `resend_id` des envois initiaux, score = date d'envoi (ms) | aucune — purge RGPD | `/api/send` |
| `idx:commercial:{clé}` | sorted set | Envois d'un commercial (clé = email en minuscules, ou `nom:{slug}` pour un ancien envoi non rattaché) | aucune — purge RGPD | `/api/send`, migration |
| `idx:contact:{contactId}` | sorted set | Envois à un contact HubSpot (alerte « déjà contacté ») | aucune — purge RGPD | `/api/send`, migration |
| `stats:day:{AAAA-MM-JJ}` | hash | Compteurs du **jour d'envoi** (heure de Paris) : `sent`, `delivered`, `opened`, `clicked`, `bounced`, `complained`, et les mêmes suffixés `\|{clé commercial}` | fin du jour + `RETENTION_DAYS` | `/api/send`, webhook, migration |
| `meta:commerciaux` | hash | Clé commercial → nom affiché | aucune | `/api/send`, migration |
| `relances_due` | sorted set | Relances J+3 planifiées (voir Relances) | membre retiré une fois traité | `/api/send`, migration |
| `meta:schema_version` | string | `2` une fois `scripts/migrate-kv.ts` passé | aucune | migration |
| `send_result:{resend_id}` | JSON | Réponse du premier envoi, renvoyée en cas de rejeu idempotent | 24 h | `/api/send` |
| `webhook_event:{svix-id}` | flag | Dédoublonnage : un événement webhook n'est traité qu'une fois | 7 jours | webhook |
| `hubspot_note:{resend_id}:{opened\|clicked}` | flag | Verrou « une seule Note HubSpot par type d'événement » (`legacy` pour les entrées antérieures) | aucune — purge RGPD | webhook, migration |
| `relance:{timestamp}` | JSON | **Ancien format** de relance, repris par la migration | ≈ J+7 | (plus écrit) |

Champs de `email_track` : les champs historiques (`contact_id`, `ps_nom`, `ps_email`, `commercial_name`, `formation_nom`, `sujet`, `statut`, `sent_at`, `opened_at`, `clicked_at`) sont conservés tels quels, si bien qu'une entrée v2 reste lisible par l'ancien code. Champs ajoutés :
`v` (2), `kind` (`initial` / `relance`), `sent_day`, `commercial_key`, `commercial_email`, `commercial_slack_id`, `commercial_hubspot_id`, `ps_rpps`, `formation_numero`, `relance_due_day`, `message_id`, `delivered_at`, `bounced_at`, `complained_at`, `first_opened_at`, `first_clicked_at`, `last_opened_at`, `open_count`, `click_count`, `auto_click_count`, et les drapeaux internes `counted_*` (un fait n'est compté qu'une fois).

### Statuts
Libellés affichés (la valeur stockée dans `email_track.statut` est entre parenthèses) :
- **Envoyé** (`envoyé`) : mail transmis via Resend
- **Reçu** (`délivré`) : accepté par le serveur du PS (`email.delivered`)
- **Ouvert** (`ouvert`) : le PS a ouvert le mail
- **Cliqué** (`cliqué`) : le PS a cliqué dans le mail (clic non automatique)
- **Adresse invalide** (`bounce`) : adresse rejetée (`email.bounced`) — état final
- **Indésirable** (`plainte`) : le PS a signalé le mail comme spam (`email.complained`) — état final

Le statut est **monotone** (envoyé < délivré < ouvert < cliqué) : un événement plus faible ne le fait jamais redescendre. **Bounce et plainte sont prioritaires** sur tous les autres (une plainte prime sur un bounce). Les dates `first_*` sont écrites une seule fois ; `last_opened_at`, `open_count` et `click_count` suivent chaque ouverture et clic humain. Seule exception à la monotonie : un clic reclassé automatique après coup (voir ci-dessous) peut faire redescendre « Cliqué » au statut précédent.

### Ouvertures et clics automatiques
**Par défaut, toute ouverture et tout clic est humain** : le commercial envoie souvent le mail pendant l'appel et le PS l'ouvre dans la seconde — ce sont les meilleurs signaux. Un événement n'est classé « automatique » (antivirus, filtre de sécurité de l'établissement) que sur des signes fiables.

Ce que Resend fournit (documentation consultée le 8 octobre 2026) :
- `email.opened` : **ni navigateur, ni adresse IP, ni heure d'ouverture** ([doc](https://resend.com/docs/webhooks/emails/opened)). Les ouvertures sont donc **toujours humaines**.
- `email.clicked` : objet `click` avec `ipAddress`, `link`, `timestamp` (heure réelle du clic) et `userAgent` ([doc](https://resend.com/docs/webhooks/emails/clicked)).

Règle appliquée aux clics (constantes dans `lib/config.ts`) :
- **Rafale** : un autre lien du même mail a été cliqué à moins de 2 secondes (`CLICK_BURST_SECONDS`), d'après l'heure réelle des clics et non leur heure d'arrivée. Tous les clics de la rafale sont automatiques, y compris ceux déjà enregistrés : s'ils avaient été comptés, le comptage est annulé (compteurs, `click_count`, statut). Deux clics sur le **même** lien restent humains.
- **Robot** : navigateur vide ou contenant une signature connue (`BOT_USER_AGENTS` : bot, crawler, spider, curl, wget, python-requests, go-http-client, headlesschrome, barracuda, mimecast, proofpoint).
- **Pas de classement par adresse IP** : il n'existe pas de liste fiable des adresses des filtres de sécurité.
- **Données conservées** : ni l'adresse IP ni le navigateur ; seulement, pour chaque clic, l'heure, le lien, le classement et sa raison (`email_clicks:{id}`, 7 jours).
- Un clic automatique est stocké (`auto_click_count`) mais ne fait pas avancer le statut, ne compte pas dans les taux et ne crée ni Note HubSpot ni notification. Il prouve en revanche la livraison (« Reçu »).
- La Note HubSpot du premier clic est créée **3 secondes après** (`FIRST_CLICK_CONFIRM_DELAY_MS`), une fois le premier clic humain relu : un clic reclassé entre-temps ne crée pas de Note.

**Limites connues :**
- Les ouvertures déclenchées sans lecture (Apple Mail Privacy Protection, proxys qui préchargent les images) restent comptées comme des ouvertures : Resend ne fournit rien pour les distinguer.
- Un antivirus qui clique **un seul** lien avec un navigateur ordinaire n'est pas détecté.
- Si les webhooks d'une même rafale arrivent à plus de 3 secondes d'écart, la Note « Email cliqué » peut être créée avant le reclassement : les compteurs et le statut sont corrigés, mais la Note reste (journal : « clic(s) précédent(s) reclassé(s) automatique(s) »).
- Un vrai PS qui clique deux liens différents en moins de 2 secondes est classé automatique (cas très improbable).

### Stats
Les stats d'une période sont la **somme des compteurs journaliers** `stats:day:*` des jours de la période : plus aucune lecture de tout l'historique. Un envoi est compté au **jour de son envoi** (heure de Paris) : une ouverture le 5 d'un mail envoyé le 1er compte pour le 1er, ce qui garde les taux sous 100 %.
- `opened` compte les envois ouverts **ou** cliqués (un clic sans ouverture détectée, pixel bloqué, compte comme une ouverture).
- `delivered` compte aussi les envois ouverts ou cliqués (une ouverture prouve la livraison).
- Tant que la migration v2 n'a pas été passée (`meta:schema_version` absent), les stats sont calculées sur les entrées elles-mêmes, avec les mêmes règles.

### Colonnes affichées
PS (nom + email) · Commercial · Formation · Statut · Envoyé · Lien HubSpot

### Rétention RGPD
Les envois sont conservés **3 ans** : constante `RETENTION_DAYS = 1095` en haut de `lib/config.ts`.
- Le cron quotidien purge les envois plus anciens : `email_track`, `email_body`, `email_clicks`, `send_result`, verrous `hubspot_note:*`, entrées de `emails_index`, `idx:commercial:*`, `idx:contact:*` et `relances_due` (et la relance rattachée à l'envoi, lot 3). Le nombre d'envois purgés est renvoyé dans `purged`.
- Les compteurs `stats:day:*` expirent d'eux-mêmes (EXPIREAT fin du jour + `RETENTION_DAYS`).
- Le corps des mails (`email_body`) n'est gardé que 90 jours (`EMAIL_BODY_TTL_DAYS`) : il ne sert qu'à pré-remplir une relance. **Limite** : pour un mail plus ancien, le corps est redemandé à Resend (`GET /emails/{id}`) ; si Resend ne le fournit plus (durée de conservation de Resend dépassée), la relance s'ouvre **sans le corps d'origine**, avec un message qui l'indique, et le commercial complète le texte ou le fait régénérer par Claude.
- **Seul le KV est purgé** : les Notes HubSpot ne sont pas concernées.

### Migration des données (schéma v2) — à faire une fois après le déploiement
Le code fonctionne **avant et après** la migration : avant, les anciennes entrées restent lisibles et les stats sont calculées sur les entrées ; les événements webhook mettent à jour une ancienne entrée sans toucher aux compteurs (la migration la comptera, d'où l'absence de double comptage). La migration reconstruit compteurs et index à partir des `email_track` existants et reprend les clés `relance:*`.

**Procédure de déploiement des données**, sur la base de **production**, juste après le déploiement et **avant le prochain cron de 8h UTC** (le nouveau cron lit `relances_due`). Chaque script affiche d'abord un rapport sans rien modifier : le lire avant de passer à l'écriture.
```bash
H=<hôte de la base KV de production>                                   # ex. xxx.upstash.io, vérifié contre KV_REST_API_URL

# 1. Sauvegarde complète (backups/kv-export-<hôte>-<date>.json) — obligatoire : les étapes 2 et 3 la refusent si elle a plus d'une heure
node scripts/migrate-kv.ts --host=$H --export

# 2. Suppression des envois de test (PS = fiche de test 18421683158 ou dethie@medere.fr), faits au nom de vrais commerciaux
node scripts/purge-test-sends.ts --host=$H                            #    rapport
node scripts/purge-test-sends.ts --host=$H --apply                    #    suppression

# 3. Migration v2 (compteurs, index, reprise des anciennes relances)
node scripts/migrate-kv.ts --host=$H --dry-run                        #    rapport (valider les noms « À VALIDER »)
node scripts/migrate-kv.ts --host=$H                                  #    migration

# 4. Contrôle : chaque fait compté une seule fois (aucune écriture, exit 1 au moindre écart)
node scripts/migrate-kv.ts --host=$H --verify

# 5. Notes HubSpot « Email ouvert » / « Email cliqué » en double
node scripts/dedupe-hubspot-notes.ts --host=$H                        #    rapport par contact (lire les cas ambigus)
node scripts/dedupe-hubspot-notes.ts --host=$H --apply                #    archivage des doublons

# Retour arrière du KV si besoin (étapes 2 à 4) :
node scripts/migrate-kv.ts --host=$H --restore=backups/<fichier>.json            # plan, aucune écriture
node scripts/migrate-kv.ts --host=$H --restore=backups/<fichier>.json --confirm  # restauration
```
Avant l'étape 1 : ajouter `email.delivered`, `email.bounced` et `email.complained` sur l'endpoint du webhook dans Resend (voir « Webhooks Resend »). Les Notes HubSpot archivées à l'étape 5 restent récupérables 90 jours dans la corbeille HubSpot ; la restauration du KV ne les concerne pas.
- Node ≥ 22.18 (le script TypeScript s'exécute sans compilation ni dépendance).
- `.env.local` (ou `ENV_FILE=<fichier>`) doit contenir les `KV_REST_API_*` de la base visée, et `AIRTABLE_*`.
- **Idempotente** : une entrée déjà migrée est ignorée ; relancer la commande ne change rien.
- **Une seule entrée par mail** : la clé est le `resend_id` du mail. Chaque fait (reçu, ouvert, cliqué…) est compté une seule fois grâce aux marqueurs `counted_*`, même si des webhooks arrivent pendant la migration (testé). `--verify` recalcule les compteurs attendus à partir de ces marqueurs, les compare aux `stats:day:*` et contrôle la cohérence fait / comptage ; il sort en erreur au moindre écart.
- Deux mails réellement envoyés en double (avant l'idempotence) restent **deux** entrées : aucun mail envoyé n'est supprimé ni fusionné.

### Envois de test — `scripts/purge-test-sends.ts`
Supprime du KV les envois dont le PS est la fiche de test (`18421683158`) ou l'adresse de test (`dethie@medere.fr`), faits au nom de vrais commerciaux pendant les essais (constantes `TEST_CONTACT_IDS` / `TEST_EMAILS` en haut du script).
- Supprimés pour chaque envoi : `email_track`, `email_body`, `email_clicks`, `send_result`, verrous `hubspot_note:*`, entrées de `emails_index`, `idx:commercial:*`, `idx:contact:*`, `relances_due` ; si l'envoi avait déjà été compté (entrée v2), sa contribution aux `stats:day:*` est retirée dans le même script atomique (`--verify` reste à 0 écart). Les anciennes clés `relance:*` du PS de test sont aussi supprimées.
- **Jamais touchés** : les envois vers d'autres PS, les Notes HubSpot.
- Garde-fous identiques à `migrate-kv.ts` : `--host` obligatoire, rapport par défaut, `--apply` pour écrire, refus sans export de moins d'une heure.

### Notes HubSpot en double — `scripts/dedupe-hubspot-notes.ts`
Avant la phase 1, le webhook créait une Note « Email ouvert » / « Email cliqué » à chaque événement. Le script archive les doublons (à lancer après la migration) :
```bash
node scripts/dedupe-hubspot-notes.ts --host=$H                 # rapport par contact, aucune modification (mode par défaut)
node scripts/dedupe-hubspot-notes.ts --host=$H --apply         # archive les doublons
# options : --contact=<id> (un seul contact), --subject-prefix=<texte> (sujets commençant par…)
```
- Contacts examinés : ceux présents dans le KV (contacts réellement écrits par l'agent). `.env.local` doit contenir `HUBSPOT_TOKEN` et les `KV_REST_API_*` de la base visée.
- **Seules les Notes au format exact de l'agent** sont prises en compte (« 👁️ Email ouvert le… », « 🖱️ Email cliqué le… », ou « 🖱️ Lien cliqué le… » créé pendant les tests, suivies de « Sujet : » et « Commercial : »). Les Notes saisies à la main et les Notes « Email envoyé » ne sont jamais touchées.
- Regroupement par contact, type, sujet et commercial. S'il existe **exactement un** mail correspondant dans le KV, la Note la plus ancienne est gardée et les autres sont archivées (corbeille HubSpot, récupérables 90 jours). Sinon (0 ou plusieurs mails avec ce sujet) : cas **ambigu**, rien n'est touché, signalé dans le rapport.
- Le script ne modifie jamais le KV.
- **Correspondance nom → email** : les anciens envois ne stockaient que le nom du commercial. Un nom n'est rattaché à un email que s'il correspond à **une seule** fiche Commerciaux **et** que le prénom de la fiche correspond à l'email (« Sarah Smadja » → `sarah.s@`). Sinon, la clé est `nom:{slug}` et le cas est listé dans le rapport `--dry-run` (ex. « Loane Deluge » dont la fiche porte `justine.m@`).
- **Restauration** : réécrit les clés de l'export (valeur et TTL restant au moment de l'export) et supprime les clés créées depuis. Les écritures faites entre l'export et la restauration (nouveaux envois, webhooks) sont perdues.
- Les exports contiennent des données personnelles : les garder hors du dépôt (`backups/` est ignoré par git) et les supprimer après usage.

---

## Webhooks Resend

### Configuration
Dans resend.com → Webhooks → endpoint :
```
https://medere-agent-email-dpc.vercel.app/api/webhooks/resend
```

Événements **traités** : `email.delivered`, `email.bounced`, `email.complained`, `email.opened` et `email.clicked`. **Les cinq doivent être cochés** sur l'endpoint dans Resend (sans `delivered`, la détection des ouvertures automatiques se base sur la date d'envoi ; sans `bounced` / `complained`, ces statuts n'apparaissent jamais). Les autres événements éventuellement activés (`email.sent`…) sont reçus puis ignorés (réponse 200).

### Fonctionnement
1. Resend envoie un webhook signé ; la signature (Svix) est vérifiée sur le body brut. Signature invalide → **400** (seul cas d'erreur).
2. Signature valide → réponse **200** dans tous les cas ; une erreur de traitement est journalisée (`[WEBHOOK] Erreur de traitement`) mais ne provoque pas de rejeu par Resend.
3. Dédoublonnage par `svix-id` (`webhook_event:*`).
4. Mise à jour atomique de `email_track:{id}` **et** des compteurs du jour d'envoi par un script Lua (`EVENT_SCRIPT`, voir Statuts). Le `message_id` fourni par Resend est enregistré (fil de discussion des relances). Un `email_id` absent du KV (ex. copie commerciale) est ignoré.
5. Une seule Note HubSpot par type (« Email ouvert » à la première ouverture, « Email cliqué » au premier clic humain, confirmé 3 secondes après), jamais pour un clic automatique ni pour reçu / adresse invalide / indésirable (`hubspot_note:*`). Si HubSpot échoue, le verrou est relâché : l'événement suivant du même type recréera la Note.

---

## HubSpot — Logging des emails

Les emails envoyés sont loggués comme **Notes** sur la fiche HubSpot du contact PS (owner = commercial).

Format de la note :
```
📧 Email envoyé à {email}
Sujet : {sujet}
---
{corps du mail}
```

La note est associée au contact via `associationTypeId: 202`. Les ouvertures et clics ajoutent une Note « 👁️ Email ouvert le… » / « 🖱️ Email cliqué le… » (une seule de chaque par email).

### Scopes requis sur la Private App HubSpot
- `crm.objects.contacts.read` — recherche contacts
- `crm.objects.notes.write` — création notes

---

## Déploiement

### Prérequis
- Node.js 18+
- Compte Vercel (compte Médéré)
- Repository GitHub : `medere-tech/medere-agent-email`

### Installation locale
```bash
git clone https://github.com/medere-tech/medere-agent-email
cd medere-agent-email
npm install
# créer .env.local avec les variables du tableau ci-dessus
npm run dev
```

### Déploiement production
```bash
git add .
git commit -m "description du changement"
git push
```
Vercel déploie automatiquement dès le push sur `main`.

### URL production
```
https://medere-agent-email-dpc.vercel.app
```

---

## Tests

Le protocole de test complet (prérequis, garde-fous, étapes, résultats attendus) est dans [`docs/TESTS.md`](docs/TESTS.md).
Les données de test se créent et se suppriment à la demande avec `scripts/seed-test.ts` (uniquement sur la base KV de **test**).

---

## Maintenance

### Ajouter un commercial
1. Airtable → table Commerciaux → ajouter un record
2. Renseigner : `hubspot_name`, `email`, `phone`, `slack_user_id`, `hubspot_id`, `Statut="Actif"`
3. L'app le détecte automatiquement au prochain chargement (cache 60s)

### Désactiver un commercial
1. Airtable → table Commerciaux → changer `Statut` de `Actif` à autre chose
2. Désactiver son compte Google Workspace `@medere.fr`

### Ajouter une formation
1. Airtable → table Formations → ajouter un record
2. Renseigner : `Nom de la formation`, `Numéro d'action DPC`, `Format`, `Public concerné`, `Statut de la formation="Active"`

### Ajouter des sessions
1. Airtable → table Sessions → ajouter un record
2. Renseigner : `Date de début de session`, `Date de fin de session`, `webflow_id`, `Numéro d'action DPC` (lien vers la formation), `Temps lisible (Webflow)`
3. Sans `webflow_id`, la session n'apparaît pas dans l'app (filtre anti-doublon)

### Filtrer les formations sans session à venir
Dans `lib/airtable.ts`, passer `FORMATIONS_REQUIRE_FUTURE_SESSION` à `true` (voir section Airtable).

### Modifier la durée de session
Dans `lib/auth.ts` :
```typescript
const SESSION_DURATION = 60 * 60 * 24 * 7 // modifier cette valeur (JWT et maxAge du cookie)
```

### Renouveler les credentials Google OAuth
1. Google Cloud Console → APIs & Services → Credentials
2. Cliquer sur le client OAuth → **Regenerate Secret**
3. Mettre à jour `GOOGLE_CLIENT_SECRET` sur Vercel → Settings → Environment Variables
4. Redéployer

### Mettre à jour le webhook Resend
Si le domaine Vercel change :
1. resend.com → Webhooks → modifier l'URL endpoint
2. Mettre à jour `RESEND_WEBHOOK_SECRET` si nécessaire

---

## Résolution de problèmes fréquents

### Une formation n'apparaît pas dans le dropdown
**Vérifier dans Airtable :**
- `Statut de la formation` = `Active` ?
- `Numéro d'action DPC` renseigné ?
- Si `FORMATIONS_REQUIRE_FUTURE_SESSION = true` : la formation a-t-elle une session future ?

### Une session n'apparaît pas
**Vérifier dans Airtable :**
- `webflow_id` renseigné ?
- Date de début dans le futur ? (sauf e-learning)
- Pour e-learning : date de fin pas encore dépassée ?
- Liée à la bonne formation via `Numéro d'action DPC` ?

### Bandeau rouge « Impossible de charger … »
Le message affiché reste lisible pour le commercial ; le détail technique (code Airtable) est dans les logs Vercel (`[FORMATIONS]`, `[SESSIONS]`, `[COMMERCIAUX]`). Vérifier `AIRTABLE_TOKEN` / `AIRTABLE_BASE_ID` et les logs Vercel.

### « HubSpot indisponible, ne crée pas le contact »
HubSpot n'a pas répondu (token, quota, panne). Ne pas créer le contact : réessayer plus tard. Logs Vercel → chercher `[CONTACT-SEARCH]`.

### Les relances Slack ne partent pas
1. Vercel → Cron Jobs → vérifier que le cron tourne
2. Réponse du cron / logs Vercel → `notified` et `errors` (chercher `[CRON]`)
3. Vérifier `SLACK_BOT_TOKEN` et `CRON_SECRET` dans les env vars Vercel
4. Vérifier que le bot Slack a les scopes `chat:write` et `im:write`
5. Vérifier que `slack_user_id` est renseigné pour le commercial dans Airtable

### Le webhook Resend ne met pas à jour le statut
1. resend.com → Webhooks → vérifier que l'URL est correcte
2. Vérifier `RESEND_WEBHOOK_SECRET` dans les env vars Vercel (signature invalide → 400 + log `[WEBHOOK] Signature invalide`)
3. Logs Vercel → chercher `[WEBHOOK]`

### Erreur 500 sur /api/sessions
Vérifier que le champ `Format` est bien dans les fields chargés dans `getSessionsByFormation`.

### « Service momentanément indisponible. Préviens Déthié. » (erreur 500)
`NEXTAUTH_SECRET` ou `CRON_SECRET` est absent des variables d'environnement. Logs : `[AUTH] NEXTAUTH_SECRET manquant` ou `[CRON] CRON_SECRET manquant`.

### Un commercial ne peut plus se connecter
1. Vérifier que son compte Google Workspace `@medere.fr` est actif
2. Vérifier que son `Statut` est `Actif` dans Airtable Commerciaux

### La note HubSpot n'apparaît pas
1. Vérifier le scope `crm.objects.notes.write` sur la Private App HubSpot
2. Logs Vercel → chercher `[HUBSPOT]`
3. Vérifier que `hubspot_id` du commercial est renseigné dans Airtable

---

## Contacts

| Rôle | Personne | Contact |
|------|----------|---------|
| Créateur / Maintenance | Déthié | dethie@medere.fr |
| Gestion formations/sessions | Maylis | maylis@medere.fr |
| Direction | Harry | harry@medere.fr |
