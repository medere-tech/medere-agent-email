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
9. [Relances](#relances)
10. [Suivi des envois et clés KV](#suivi-des-envois-et-clés-kv)
11. [Webhooks Resend](#webhooks-resend)
12. [HubSpot — Logging des emails](#hubspot--logging-des-emails)
13. [Déploiement](#déploiement)
14. [Modèle de rédaction](#modèle-de-rédaction)
15. [Tests](#tests)
16. [Maintenance](#maintenance)
17. [Résolution de problèmes fréquents](#résolution-de-problèmes-fréquents)

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
│       │   ├── login/route.ts            # Démarre la connexion Google (paramètre state)
│       │   ├── callback/google/route.ts  # Callback OAuth Google (GET, vérifie le state)
│       │   └── logout/route.ts           # Déconnexion (POST uniquement)
│       ├── me/route.ts                   # Rôle et fiche de la personne connectée
│       ├── commerciaux/route.ts          # Liste des commerciaux actifs
│       ├── formations/route.ts           # Liste des formations actives
│       ├── sessions/route.ts             # Sessions par formation
│       ├── contact-search/route.ts       # Recherche contacts HubSpot (502 si HubSpot indisponible)
│       ├── contact-history/route.ts      # Envois des 14 derniers jours au contact (« déjà contacté »)
│       ├── generate/route.ts             # Rédaction du mail par Claude au fil de l'eau (NDJSON, + upsell)
│       ├── send/route.ts                 # Envoi (contrôles) → lib/deliver.ts
│       ├── relance/route.ts              # Brouillon de relance (GET), generate/ (Claude), send/ (envoi dans le fil)
│       ├── suivi/route.ts                # API de la page suivi (filtres, indicateurs, liste paginée)
│       ├── suivi/export/route.ts         # Export CSV de la vue filtrée
│       ├── cron/
│       │   └── relance/route.ts          # Cron job relances J+3
│       └── webhooks/
│           └── resend/route.ts           # Webhooks tracking email (ouvert/cliqué)
├── components/
│   ├── AgentMail.tsx                     # Composant principal (6 étapes)
│   └── RelancePanel.tsx                  # Fenêtre de relance par mail (/suivi)
├── lib/
│   ├── airtable.ts                       # Fonctions Airtable
│   ├── deliver.ts                        # Chaîne d'envoi commune (Resend, suivi, copie, Note, rejeu)
│   ├── generated-mail.ts                 # Lecture du mail rédigé par Claude (objet + texte, au fil de l'eau)
│   ├── note-queue.ts                     # Notes HubSpot en échec : nouveaux essais, alerte
│   ├── relance.ts                        # Règles et brouillon de la relance par mail
│   ├── render-mail.ts                    # Rendu texte → HTML + texte brut, avertissements sur les liens (fonctions pures)
│   ├── slack.ts                          # DM Slack et alertes techniques
│   ├── suivi-query.ts                    # Requête de /suivi : filtres, période (Paris), compteurs, script Lua
│   ├── auth.ts                           # Session JWT (cookie)
│   ├── claude.ts                         # Génération mail IA
│   ├── config.ts                         # Constantes (RETENTION_DAYS…) et profil administrateur (variables ADMIN_*)
│   ├── hubspot.ts                        # Recherche contacts + Notes HubSpot
│   ├── identity.ts                       # Personne connectée, rôle, contrôle d'accès des routes
│   ├── ratelimit.ts                      # Limites de débit (KV)
│   ├── roles.ts                          # Règles des rôles et choix de l'expéditeur (fonctions pures)
│   ├── session-label.ts                  # Libellés des sessions (jours calculés, Paris) et contrôle des dates (fonctions pures)
│   ├── kv.ts                             # Client Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN)
│   ├── kv-schema.ts                      # Noms de clés KV, jours, scripts Lua atomiques (sans import)
│   └── tracking.ts                       # Enregistrement des envois, événements webhook, stats, purge RGPD
├── docs/
│   └── TESTS.md                          # Protocole de test complet
├── scripts/
│   ├── dedupe-hubspot-notes.ts           # Archive (après sauvegarde) et restaure les Notes HubSpot ouvert / cliqué en double
│   ├── migrate-kv.ts                     # Export / migration v2 / vérification / restauration des données KV
│   ├── purge-test-sends.ts               # Supprime du KV les envois au PS de test
│   ├── seed-test.ts                      # Crée / supprime les données de test (base KV de test)
│   └── test-session-dates.ts             # Tests des libellés de session et du contrôle des jours
├── backups/                              # Exports KV (migrate-kv.ts --export) — ignoré par git
├── instrumentation.ts                    # Démarrage du serveur : préchauffage des données Airtable
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
| `ADMIN_EMAIL` | Email Google de l'administrateur (voir « Rôles et accès ») | ex. `prenom.nom@medere.fr` |
| `ADMIN_NAME` | Nom affiché et signature de l'administrateur | ex. `Prénom Nom` |
| `ADMIN_HUBSPOT_OWNER_ID` | Owner HubSpot de l'administrateur (Notes de ses envois) | HubSpot → Paramètres → Utilisateurs (ex. `100000001`) |
| `ADMIN_SLACK_USER_ID` | Slack de l'administrateur : DM de relance de ses envois et **alertes techniques** | Slack → profil → « Copier l'ID de membre » (ex. `U00000000AA`) |
| `ADMIN_PHONE` | Téléphone de la signature de l'administrateur — **facultatif** | — |

> Une variable `ADMIN_*` obligatoire manquante désactive le rôle administrateur (avertissement `[CONFIG] Rôle administrateur désactivé` dans les journaux) sans arrêter l'app ; les alertes techniques ne partent plus (journalisées seulement).
>
> **Développement local uniquement** : `DEV_FORCE_ROLE` (voir « Rôles et accès ») et les `TEST_*` des scripts (`docs/TESTS.md`). Ne jamais les créer sur Vercel : `DEV_FORCE_ROLE` y serait ignorée et une erreur journalisée.

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
Commercial connecté présélectionné et verrouillé ; l'administrateur envoie à son nom par défaut (« Prénom Nom (moi) », profil des variables `ADMIN_*`) ou choisit n'importe quel commercial actif (voir « Rôles et accès »).

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
**Alerte « déjà contacté »** : dès qu'un contact est choisi, `POST /api/contact-history` (corps `{ contactId, email, rpps }`) lit `idx:contact:{id}` et liste les envois à ce contact des **14 derniers jours** (`CONTACT_HISTORY_DAYS`), tous commerciaux confondus : mail ou relance, qui, quand, quelle formation, quel statut (Envoyé, Reçu, Ouvert, Cliqué, Adresse invalide, Indésirable). Non bloquante. Si la vérification échoue, un message invite à consulter le suivi.

**Étape 5 — Aperçu**
- **Rédaction au fil de l'eau** : l'étape 5 s'ouvre dès que le serveur répond (contrôles d'identité et de débit seulement ; les formations proposées sont calculées ensuite, dans le flux) ; l'objet puis le texte s'écrivent progressivement pendant que Claude rédige (`/api/generate` répond en NDJSON : `start`, `delta`, `done` ou `error` ; format demandé à Claude : « Objet : … », ligne vide, texte — lu par `lib/generated-mail.ts`). Pendant la rédaction, les champs sont en lecture seule et l'envoi désactivé ; « Retour » annule la rédaction (le serveur arrête Claude). En cas d'échec, retour à l'étape 4 avec « La rédaction du mail a échoué. Réessaie. ».
- **Dates des sessions calculées dans le code** (`lib/session-label.ts`), jamais par Claude : à partir des dates Airtable, en fuseau Europe/Paris, chaque session reçoit un libellé complet que Claude recopie mot pour mot (règle `DATES_RULE` du prompt : interdiction de calculer, déduire ou reformuler une date, un jour ou un horaire). `/api/generate` ne reçoit du navigateur que les identifiants de la formation et des sessions, et relit leurs dates dans le cache Airtable (`getFormationAndSessions`).
  - classe virtuelle : 1ère et 2ème soirée (jamais la date de début de session si elle diffère), « en soirée à partir de 19h00 » — « Session 26.010 : mardi 13 et jeudi 15 octobre 2026, en soirée à partir de 19h00 » ;
  - présentiel : date du présentiel — « Session 26.004 : jeudi 17 décembre 2026 » (aucun horaire : il n'existe pas dans Airtable) ;
  - e-learning : « Session 26.038 : du jeudi 1er octobre 2026 au jeudi 15 avril 2027 ».
  Même libellé dans la relance rédigée et le brouillon de relance. Le champ `Temps lisible (Webflow)` n'est plus utilisé dans les mails.
- **Contrôle des jours de la semaine** (`checkWeekdays`, `lib/session-label.ts`) : chaque « jour + date » du texte (« lundi 13 octobre 2026 », « mardi 13 et jeudi 15 octobre », date sans année) est comparé au calendrier réel. Une incohérence affiche, à l'étape 5 et dans la fenêtre de relance, un avertissement « N dates incohérentes : corrige le texte avant l'envoi » avec le jour exact (« le 13 octobre 2026 est un mardi, pas un lundi »), recalculé à chaque modification du texte ; non bloquant. Elle est aussi journalisée côté serveur (`[GENERATE]` / `[RELANCE] Jours de la semaine incohérents`). Tests : `node scripts/test-session-dates.ts`.
- **Parcours d'inscription en 7 étapes** (`lib/dpc-steps.ts`, source unique pour le mail, la relance rédigée et le brouillon de relance). Depuis le 15 septembre 2026, l'ANDPC impose l'authentification forte : l'étape 3, entre « S'identifier » et « Actions DPC », est reprise mot pour mot — « Saisissez le code de sécurité reçu par SMS sur votre téléphone mobile (authentification forte exigée par l'ANDPC depuis le 15 septembre 2026). » —, suivie du conseil de vérifier son numéro de mobile dans l'espace personnel agencedpc.fr. Pour modifier le parcours, changer seulement `lib/dpc-steps.ts`.
- **Onglets « Texte » / « Aperçu »** : l'aperçu affiche le mail **tel qu'il sera reçu** (De, À, Objet, puis le HTML produit par la même fonction `renderMail` que l'envoi, avec l'apparence par défaut d'une messagerie). Un clic sur un lien de l'aperçu l'ouvre dans un nouvel onglet.
- **Avertissements sur les liens** (`linkWarnings`, `lib/render-mail.ts`), non bloquants, aussi dans la fenêtre de relance : lien sans texte ou sans adresse, espace dans l'adresse, adresse ne commençant ni par `https://` ni par `www.`, parenthèse manquante, texte entre crochets sans adresse (« [Lien d'inscription] »), protocole mal écrit (`htps://`, `https:/`, `https//`), extension de site manquante (`www.agencedpc/…`).

**Étape 6 — Confirmation**
Statuts : mail envoyé ✓, Note HubSpot sur la fiche du PS ✓, relance J+3 ✓.

Toute erreur d'API (Airtable, HubSpot, session expirée…) est affichée dans un bandeau d'erreur au lieu d'aboutir à une liste vide silencieuse.

**Design** : toute l'interface (assistant, fenêtre de relance, `/suivi`) est en **zinc monochrome**, sans aucune couleur ni émoji, avec des icônes SVG : erreurs en bandeau gris clair à bordure soutenue (`bg-zinc-50 border-zinc-400`), avertissements (« déjà contacté », liens à vérifier, aucun contact trouvé) en bandeau blanc à bordure grise (`border-zinc-300`). Seule exception : le logo Google de la page de connexion (charte Google).

---

## Authentification

### Technologie
Google OAuth 2.0 natif — aucune librairie d'auth. JWT signé avec `jose`.

### Flux
1. Utilisateur non connecté → redirigé vers `/login`
2. Clic « Se connecter avec Google » → `GET /api/auth/login` : génère un paramètre `state` aléatoire, le garde dans un cookie httpOnly (`medere_oauth_state`, 10 minutes, limité à `/api/auth`) et redirige vers Google
3. Retour sur `/api/auth/callback/google` : le `state` renvoyé par Google doit être celui du cookie, sinon `/login?error=invalid_state` (« La connexion a expiré ou a été interrompue. Recommence. ») ; le cookie est effacé dans tous les cas (usage unique). Protège contre la connexion forcée (login CSRF).
4. Vérification côté serveur que l'email est `@medere.fr` et vérifié
5. Cookie de session JWT créé (httpOnly, secure en production, 7 jours)
6. Middleware vérifie le cookie sur chaque requête ; chaque route métier relit ensuite **le rôle** de la personne (voir « Rôles et accès »)

### Déconnexion
Bouton « Se déconnecter » dans le header de la page principale et de `/suivi`.
Il envoie un `POST /api/auth/logout` (un simple lien GET ne peut pas déconnecter), qui supprime le cookie et redirige vers `/login` (303).

### Durée de session
7 jours, pour l'expiration du JWT comme pour le `maxAge` du cookie. Modifiable dans `lib/auth.ts` :
```typescript
const SESSION_DURATION = 60 * 60 * 24 * 7 // 7 jours (JWT et maxAge du cookie)
```

> Le JWT de session reste valide 7 jours, mais **l'accès d'un commercial est révocable** : passer sa fiche Airtable en « Plus actif » le bloque partout (génération, envoi, suivi), même avec une session valide, dans le délai décrit dans « Rôles et accès » (en pratique moins d'une minute). Un compte `@medere.fr` sans fiche garde, lui, l'accès en lecture au suivi jusqu'à l'expiration de sa session. L'administrateur n'est jamais bloqué par sa fiche.

### Sécurité
- Cookie `httpOnly` — inaccessible via JavaScript
- Cookie `secure` en production — HTTPS uniquement
- Vérification `@medere.fr` côté serveur (pas seulement côté Google)
- Protection CVE-2025-29927 dans `middleware.ts`
- JWT signé — impossible à falsifier sans `NEXTAUTH_SECRET`
- `NEXTAUTH_SECRET` absent → 500 explicite (log `[AUTH] NEXTAUTH_SECRET manquant`) au lieu d'une signature avec une clé vide

### Couper l'accès à un commercial (départ de Médéré)
1. Airtable → table Commerciaux → passer son `Statut` à « Plus actif » : il est bloqué partout, même avec une session ouverte (message « Ton accès à l'Agent Mail a été désactivé »), dans le **délai maximal de révocation** ci-dessous. Ne s'applique pas à l'administrateur.
2. Désactiver son compte Google Workspace `@medere.fr` : il ne pourra plus se reconnecter, ni à l'Agent Mail ni aux autres outils.

Pour une coupure immédiate de **tous** les accès, changer `NEXTAUTH_SECRET` sur Vercel et redéployer : toutes les sessions deviennent invalides.

### Rôles et accès
Le rôle est déterminé **côté serveur** à chaque requête, à partir de l'email de la session Google rapproché de la table Commerciaux (champ `email`, sans tenir compte de la casse). Le navigateur ne fournit jamais l'identité du commercial : `/api/generate` et `/api/send` ne reçoivent que l'identifiant de la fiche choisie à l'étape 1 (`commercial_id`) et relisent nom, email, owner HubSpot et Slack dans Airtable.

| Rôle | Qui | Étape 1 | Générer / envoyer | Suivi |
|---|---|---|---|---|
| Administrateur | email `ADMIN_EMAIL` (profil complet dans les variables `ADMIN_*`, **indépendant d'Airtable** : accès complet que sa fiche existe, soit « Plus actif » ou ait été supprimée) | son nom par défaut (profil des variables, « (moi) ») ou n'importe quel commercial actif | en son nom (nom, email, owner HubSpot, Slack, téléphone des variables `ADMIN_*`), ou au nom de n'importe quel commercial actif — **tracé** : `sent_by` / `sent_by_name` dans `email_track`, ligne « Envoyé par … pour le compte de … » dans la Note HubSpot | tout ; relance n'importe quel mail |
| Commercial | fiche « Actif » | sa fiche, présélectionnée et **verrouillée** | uniquement en son nom (un autre identifiant envoyé → 403 « Tu ne peux générer et envoyer des mails qu'en ton nom. ») | tout |
| Lecteur | compte `@medere.fr` sans fiche | — (message « Ton compte n'est pas associé à une fiche commercial… ») | non (403) | lecture seule |
| Désactivé | fiche « Plus actif » (personne partie de Médéré ; jamais l'administrateur) | — (message « Ton accès à l'Agent Mail a été désactivé ») | non (403) | non (403) |

- **Profil administrateur** : aucun identifiant dans le code. Le profil n'apparaît jamais dans la liste des commerciaux vue par les autres utilisateurs (ni sa fiche Airtable, même active) ; à l'étape 1, l'administrateur voit « son nom (moi) » en tête de liste (identifiant réservé `admin:self`). Un mail qu'il a envoyé en son nom se relance en son nom, quel que soit l'état de sa fiche. Une variable `ADMIN_*` obligatoire manquante : rôle administrateur désactivé (l'email est alors traité comme n'importe quel compte, selon sa fiche).
- **Mode de test du rôle** (développement local uniquement) : `DEV_FORCE_ROLE=commercial` (ou `lecteur`, `inactif`) dans `.env.local` fait passer **la session de l'administrateur** pour ce rôle, sans rien écrire dans Airtable (commercial : fiche fictive construite à partir du profil administrateur, identifiant `dev:commercial`). Actif seulement si `NODE_ENV=development` (`npm run dev`) **et** si `VERCEL` n'est pas défini ; `npm run build` / `next start` et Vercel l'ignorent, avec une erreur `[IDENTITE] DEV_FORCE_ROLE présent hors développement local` dans les journaux (aussi contrôlé au démarrage, `instrumentation.ts`). Quand il est actif : avertissement `[IDENTITE] MODE TEST` dans les journaux, aucun bandeau dans l'interface.

- Fiches Commerciaux **en mémoire, jamais attendues** : chaque requête utilise la dernière version connue des fiches (mémoire de l'instance, sinon KV `cache:airtable:fiches:v1`, conservé après un redémarrage) ; dès qu'elle a plus de 60 secondes (`COMMERCIAL_CACHE_SECONDS`), elle est relue dans Airtable **en arrière-plan** (environ 1 s), sans faire attendre la requête. Sur un serveur qui tourne en continu, la relecture a aussi lieu chaque minute (`instrumentation.ts`).
- **Délai maximal de révocation** (passage à « Plus actif », et de même pour un retour à « Actif » ou un changement d'email) :
  - **app utilisée** (au moins une requête par minute, ou serveur qui tourne en continu) : **60 secondes + environ 1 seconde** de relecture Airtable ;
    mesuré le 8 octobre 2026 (production locale, une requête toutes les 2 s) : blocage 27 s après le passage à « Plus actif », accès rétabli 27 s après le retour à « Actif », aucune requête ralentie ;
  - **app inutilisée depuis plus de 60 secondes** (instance Vercel en sommeil) : la **première requête** qui suit est encore traitée avec l'ancienne fiche — c'est elle qui déclenche la relecture —, toutes les suivantes utilisent la fiche à jour. Une personne révoquée peut donc passer **une requête de plus** (un affichage, ou au pire un envoi) si personne n'a utilisé l'app dans la minute précédente.
  - Pour un blocage immédiat et certain (départ, compte compromis) : passer la fiche en « Plus actif » **et** changer `NEXTAUTH_SECRET` sur Vercel et redéployer (toutes les sessions sont invalidées, voir « Authentification »).
- Plusieurs fiches avec le même email : la fiche « Actif » est retenue.
- `GET /api/me` renvoie le rôle et la fiche de la personne connectée (403 si désactivée ; pour l'administrateur, la « fiche » est son profil, identifiant `admin:self`).
- Routes métier protégées : `/api/generate`, `/api/send`, `/api/sessions`, `/api/contact-search` (administrateur et commercial) ; `/api/suivi`, `/api/formations`, `/api/commerciaux`, `/api/me` (lecteur compris).

### Limites de débit
Par personne connectée, fenêtre fixe de 10 minutes dans le KV (`ratelimit:{action}:{email}:{fenêtre}`, expirée avec la fenêtre) — `RATE_LIMITS` dans `lib/config.ts` :
- génération : 30 / 10 min ; envoi : 20 / 10 min ;
- au-delà : 429 « Tu as atteint la limite de 30 générations en 10 minutes. Réessaie dans N minutes. » ;
- KV indisponible : la requête passe (journalisé `[RATELIMIT]`) plutôt que de bloquer les commerciaux.

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
- Toute requête **paginée** passe par `atAll()` et n'utilise **jamais** le cache HTTP de Next (`cache: 'no-store'`), première page comprise. Une page 1 servie depuis ce cache porterait un `offset` expiré et provoquerait `422 LIST_RECORDS_ITERATOR_NOT_AVAILABLE`.
- **Aucun utilisateur n'attend Airtable** : fiches Commerciaux, formations et table Sessions complète sont **toujours servies depuis la dernière version connue** — mémoire de l'instance, sinon KV (`cache:airtable:fiches:v1`, `cache:airtable:formations:v1`, `cache:airtable:sessions:v1`, partagés entre instances, conservés 30 jours, donc aussi après un redémarrage ou un nouveau déploiement) — puis **rafraîchies en arrière-plan** quand elles ont dépassé leur durée de fraîcheur (fiches : 60 s ; formations et sessions : 5 minutes, `AIRTABLE_CACHE_SECONDS`). Une modification Airtable apparaît donc dans l'app en 5 minutes environ (fiches : voir « Rôles et accès »). Sur Vercel, le rafraîchissement est confié à `waitUntil` pour aller au bout même après la réponse. Si Airtable est indisponible, la dernière version connue reste servie (erreur dans les journaux).
- **Préchauffage** : au démarrage du serveur, `instrumentation.ts` charge ces tables (fiches, formations, sessions, catalogue ; depuis le KV, ou Airtable si le KV est vide) puis les rafraîchit chaque minute tant que le serveur tourne. Seul un tout premier démarrage avec un KV vide et aucune requête préalable ferait attendre Airtable. Les sessions sont filtrées par formation et par date à chaque appel (la date change chaque jour, pas le cache).
- **Préchargement côté navigateur** : à l'arrivée sur l'assistant, le navigateur charge le rôle, les formations et la liste des commerciaux (administrateur).
- **Formations proposées en fin de mail** : calculées à partir des caches (catalogue des formations actives `cache:airtable:catalogue:v1` + table Sessions), sans requête Airtable (quelques millisecondes au lieu de plusieurs secondes). Les formations déjà suivies par le PS sont pré-calculées dès que le contact est choisi à l'étape 4 (`/api/contact-history` lance `prefetchFormationsDejaFaites`) et gardées 10 minutes (`cache:deja_faites:{empreinte SHA-256 de l'email et du RPPS}`). La rédaction ouvre l'étape 5 avant ce calcul.
- **Objectif de réactivité** : aucune action ne fait attendre le commercial plus de 300 ms, sauf la rédaction du mail elle-même et la recherche de contact (temps de réponse de HubSpot, 300 à 600 ms). Mesures : voir le rapport du lot « instantané ».
- La recherche Clients (une page) garde le cache Next de 60 s.
- Le cron lit toujours Airtable sans cache (inscriptions et correspondance session → formation à jour).
- Recherche de contact HubSpot **progressive** (`POST /api/contact-search`, corps `{ q, part }`) : la première passe (la plus pertinente : email, RPPS ou recherche texte, `part: 'first'`) et les passes complémentaires (`part: 'rest'` : texte sans accents, prénom + nom, mots séparés, en parallèle) partent en même temps ; la première liste s'affiche dès son arrivée, les contacts supplémentaires sont **ajoutés à la suite** (aucun réordonnancement, la sélection en cours n'est pas touchée). « Aucun contact trouvé » n'apparaît qu'une fois toutes les passes terminées. Une réponse 429 de HubSpot est retentée jusqu'à 2 fois.

### Champs Airtable utilisés — Sessions

| Champ Airtable | Usage |
|----------------|-------|
| `session_id` | Identifiant unique session |
| `Numéro de session` | Affiché dans l'app |
| `Date de début de session` | Filtre sessions futures ; libellé e-learning (début) ; à défaut de date de soirée / présentiel |
| `Date de fin de session` | Filtre e-learning en cours ; libellé e-learning (fin) |
| `Date 1ère soirée CV / Date Présentiel` | Libellé des mails (classe virtuelle, présentiel) |
| `Date 2ème soirée CV` | Libellé des mails (classe virtuelle) |
| `Date limite d'inscription` | Disponible mais non affiché |
| `Temps lisible (Webflow)` | Affiché à l'étape 3 seulement (jamais dans les mails) |
| `Numéro d'action DPC` | Champ lié → IDs des records Formation |
| `webflow_id` | Filtre anti-doublon |
| `Format` (formation) | Détection e-learning |

---

## Envoi des mails — idempotence et copie commerciale

### Rendu du texte
Une seule fonction, `renderMail` (`lib/render-mail.ts`, sans dépendance), produit le HTML **et** la version texte brut de chaque mail envoyé (envoi initial, relance, copie au commercial) :
- le texte saisi est **échappé** (« < », « & »… ne cassent jamais le mail) ; retours à la ligne → `<br>` ;
- liens Markdown `[texte](url)` → lien ; URL brutes (`http://`, `https://`, `www.`) → lien, **jamais à l'intérieur d'un lien déjà créé** ;
- la ponctuation finale (`. , ; : ! ? » "`) et une parenthèse fermante non appariée sont **exclues** de l'URL (« … sur www.agencedpc.fr/professionnel/. » donne un lien valide) ;
- version **texte brut** envoyée avec le HTML (`text`) : `[texte](url)` → « texte (url) ».

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

## Relances

### Relance par mail depuis /suivi
Dans le détail d'un mail, bouton **« Relancer »** (ou lien « Préparer la relance par mail » du DM J+3, qui ouvre `/suivi?relance={resend_id}`). La fenêtre de relance propose :
- objet `Relance : votre formation {nom de la formation}` ;
- texte pré-rempli **identique quel que soit le statut du mail d'origine** : formule d'appel (« Bonjour {titre} {nom}, »), introduction neutre (« Je me permets de revenir vers vous concernant la formation … »), prochaines sessions de la formation (cache Airtable, au plus 3), les 7 étapes d'inscription à jour avec le conseil sur le numéro de mobile, puis la signature (nom, email, téléphone de la fiche). **Le mail d'origine n'est pas recopié** (il peut contenir l'ancien parcours en 6 étapes) : la relance se suffit à elle-même ;
- **RGPD** : aucun texte destiné à un PS (mail, relance rédigée, brouillon) ne mentionne ni ne laisse deviner le suivi des ouvertures et des clics. Le statut (non ouvert, ouvert sans clic, cliqué) n'est visible que du commercial (`/suivi`, DM Slack, Notes HubSpot) et **n'est jamais transmis au prompt** ; les prompts du mail et de la relance contiennent la consigne `NO_TRACKING_RULE` (`lib/dpc-steps.ts`) ;
- tout est modifiable ; **« Rédiger la relance »** fait rédiger une relance sur le même modèle (introduction neutre, sessions, numéro DPC, 7 étapes, signature ; même limite de débit que la génération), **une seule fois par mail d'origine** : le bouton disparaît ensuite (« Rédigée · modifiable à la main »), le texte reste modifiable à la main ;
- un brouillon rédigé enregistré avant ce changement (sans `v: 2`) est ignoré : la relance est rédigée de nouveau au format neutre.

Rédaction unique, contrôlée côté serveur (`/api/relance/generate`) :
- à la première rédaction, le texte de Claude est enregistré dans `relance_draft:{resend_id}` (supprimé avec l'envoi par la purge RGPD) ;
- tout appel suivant pour ce mail — rechargement, autre onglet, administrateur, appel direct — renvoie ce brouillon **sans appeler Claude** (`dejaRedigee: true`, journal « Brouillon déjà rédigé renvoyé, sans appel à Claude ») ; `GET /api/relance` pré-remplit la fenêtre avec ce texte (`redigee: true`) ;
- verrou atomique `relance_gen_lock:{resend_id}` (SET NX, 180 s) : deux demandes simultanées ne font **qu'un appel à Claude**, la seconde attend le brouillon de la première ;
- si Claude échoue, le verrou est libéré (script `RELEASE_LOCK_SCRIPT`, seulement par son propriétaire) et rien n'est enregistré : un nouvel essai est possible.

Règles (vérifiées côté serveur à la préparation **et** à l'envoi — `lib/relance.ts`) :
- **une seule relance par mail** (verrou `relance_lock:{id}` + `relance_id` sur le mail d'origine) ; un double clic ou un rejeu de la même requête renvoie la même relance ;
- seul **l'auteur** du mail peut relancer, ou un **administrateur** (la relance part alors au nom de l'auteur, avec `sent_by` et la mention dans la Note HubSpot) ;
- impossible en cas d'**adresse invalide** ou de mail **signalé comme indésirable**, ou si le commercial du mail n'est plus actif ; le bouton est désactivé et la raison affichée.

Envoi : **envoi complet** (même chaîne que l'envoi initial, `lib/deliver.ts` : idempotence, suivi KV, copie au commercial, Note HubSpot), dans le **fil du mail d'origine** : en-têtes `In-Reply-To` et `References` = Message-ID du mail d'origine. Ce Message-ID est celui fourni par Resend dans les webhooks (`message_id`, enregistré dans `email_track`), sinon demandé à l'API Resend (`GET /emails/{id}`). Outlook et Apple Mail regroupent la relance avec le mail d'origine ; **Gmail ne le fait pas** car il exige aussi un objet identique (l'objet « Relance : votre formation … » est un choix volontaire).

Rattachement : la relance est une entrée `email_track` de `kind: 'relance'` avec `parent_id` ; le mail d'origine reçoit `relance_id` et `relance_sent_at`, et sort de `relances_due` (plus de DM J+3). La relance n'est pas dans `emails_index` (elle s'affiche sous le mail d'origine dans `/suivi`) mais dans `idx:commercial` / `idx:contact`. Ses compteurs sont **séparés** (`relance_sent`, `relance_opened`…), hors des taux principaux.

### Relance J+3 par DM Slack
À chaque envoi initial, la relance est planifiée dans `relances_due` (score = jour d'échéance J+3, heure de Paris, à 00:00 UTC). Le cron (`/api/cron/relance`, 8h UTC) traite **toutes** les relances dont l'échéance est passée — y compris les jours manqués (**rattrapage**). Chaque relance est « réclamée » par `ZREM` : deux passages simultanés n'envoient jamais deux DM.
- **Pas de DM** si : une relance mail est déjà partie, adresse invalide, signalé comme indésirable, ou PS **inscrit** à une session de la formation (Airtable : par RPPS, sinon RPPS retrouvé par l'email dans Clients). Airtable indisponible : le DM part quand même et l'erreur est remontée dans l'alerte.
- Le DM indique le **statut** (non ouvert / ouvert sans clic / cliqué) et contient le lien **« Préparer la relance par mail »** vers `/suivi?relance={resend_id}`, plus la fiche HubSpot. `slack_relance_at` est posé sur l'envoi.
- Slack en échec : nouvel essai au passage suivant, jusqu'à 3 fois (`SLACK_RELANCE_MAX_ATTEMPTS`, compteur `slack_relance_attempts:{membre}`).
- Commercial sans `slack_user_id` : pas de DM, erreur remontée dans l'alerte.
- Anciennes clés `relance:{timestamp}` non rattachées (`legacy:relance:…` dans `relances_due`, voir la migration) : DM sans statut, avec un lien vers `/suivi`, puis la clé est supprimée.

### DM au premier clic
Au **premier clic humain** du PS (jamais pour un clic automatique), le commercial reçoit un DM « {PS} vient de cliquer dans ton mail … C'est le bon moment pour l'appeler. », **une seule fois par envoi** (`click_notified_at`). Il part après la confirmation du premier clic (3 secondes, voir « Ouvertures et clics automatiques »), en même temps que la Note HubSpot.

### Alertes techniques
DM Slack à l'administrateur (`ADMIN_SLACK_USER_ID`, `alertSlackUserId()` dans `lib/config.ts`) :
- **erreurs du passage quotidien** du cron (un message récapitulatif, avec le détail de chaque erreur) ;
- **Note HubSpot en échec définitif** : toute Note en échec (envoi, relance, ouverture, clic) est mise dans la file `hubspot_retry` (+ `hubspot_retry:{id}`, 7 jours) ; le cron la retente toutes les 6 heures (`HUBSPOT_RETRY_DELAY_HOURS`) ; après 4 essais au total (`HUBSPOT_RETRY_MAX_ATTEMPTS`), elle est abandonnée et l'alerte détaille le mail, le contact et les erreurs.

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
Vercel → projet → **Cron Jobs** dans le menu gauche → voir le dernier statut d'exécution. La réponse JSON contient `{ date, notified, skipped, retried, purged, notes, errors }` : DM envoyés, relances non notifiées par motif (`inscrit`, `adresse_invalide`, `indesirable`, `relance_mail`, `introuvable`), DM reportés, envois purgés (RGPD), Notes HubSpot retentées (`created`, `requeued`, `abandoned`). S'il y a des erreurs, elles arrivent aussi en DM d'alerte.

---

## Suivi des envois et clés KV

Page accessible à `/suivi` — réservée aux utilisateurs connectés (lecteur compris, en lecture seule).

### Page /suivi
- **Période** : aujourd'hui, 7 jours, 30 jours (par défaut), ce mois, mois dernier, plage personnalisée (deux champs date). Jours calendaires, heure de Paris. La liste, les indicateurs et l'export suivent la période.
- **Indicateurs** : bloc « Équipe » toujours visible, à côté du bloc « Mes envois » de la personne connectée (si elle a une fiche) ; mails envoyés (et reçus), taux d'ouverture (N ouverts), taux de clic (N cliqués). Calculés à partir des compteurs journaliers `stats:day` de la période. Au-dessus de la liste, une ligne résume la **vue filtrée** (N mails, ouverts, cliqués).
- **Filtres** : « Mes envois » (activé par défaut pour un commercial, désactivé pour un administrateur ; absent pour un lecteur, qui n'a pas de fiche), commercial (désactivé quand « Mes envois » est actif), statut (Envoyé, Reçu, Ouvert, Cliqué, Adresse invalide, Indésirable), formation (formations présentes sur la période, avec leur nombre de mails), recherche par nom ou email du PS (sans tenir compte des accents ni des majuscules, appliquée 250 ms après la dernière frappe).
- **Liste** : statuts et libellés validés ; détail avec dates et compteurs ; relance affichée sous le mail d'origine et bouton « Relancer » (voir « Relances »).
- **Avertissement de fiabilité** : `TRACKING_RELIABLE_SINCE` (`lib/config.ts`, date AAAA-MM-JJ à renseigner le jour du déploiement ; `null` = aucun avertissement). Pour une période qui commence avant cette date : « Taux d'ouverture antérieurs au JJ/MM/AAAA surestimés (copie commerciale comptée). »
- **Export CSV** de la vue filtrée (toutes les lignes, sans pagination) : UTF-8 avec BOM, séparateur « ; » (Excel en français), 13 colonnes (date d'envoi, commercial, envoyé par, PS, email, formation, numéro DPC, statut, ouvert le, cliqué le, relance envoyée le, statut de la relance, objet). Les cellules commençant par `= + - @` sont neutralisées (injection de formules).
- **Actualisation** automatique toutes les minutes, **coupée quand l'onglet est caché** (`visibilitychange`) ; au retour sur l'onglet, une actualisation immédiate.
- **Réactivité** : la liste affichée reste visible pendant une mise à jour ; les vues déjà vues s'affichent tout de suite puis s'actualisent ; les autres périodes sont préchargées dès le premier affichage.

**API** : `POST /api/suivi` et `POST /api/suivi/export`, corps JSON `{ from, to, mine, commercial, statut, formation, q, page }` (POST : la recherche, qui peut être un email de PS, n'apparaît jamais dans l'adresse de la requête). `facets: 1` renvoie les formations de la période. Logique dans `lib/suivi-query.ts` ; un seul script Lua (`SUIVI_QUERY_SCRIPT`, `lib/kv-schema.ts`) parcourt la période sur `emails_index` (ou `idx:commercial:{clé}`, relances écartées), applique statut, formation et recherche, et renvoie en un aller-retour le total, la page avec ses entrées et ses relances, et les indicateurs de la vue quand un filtre statut, formation ou recherche est actif (sinon, compteurs journaliers). Période limitée à 1 100 jours (au-delà, la purge RGPD a tout supprimé).

### Clés KV (schéma v2)

Les noms de clés et les scripts Lua sont centralisés dans `lib/kv-schema.ts`. Toute écriture qui touche plusieurs clés (envoi, événement webhook, migration) passe par un **script Lua atomique**.

| Clé | Type | Contenu | Expiration | Écrit par |
|-----|------|---------|------------|-----------|
| `email_track:{resend_id}` | JSON | Données de l'envoi (détail ci-dessous) | aucune — purge RGPD | `/api/send` (création NX), webhook, migration |
| `email_body:{resend_id}` | JSON | `{ corps }` du mail — **plus écrit** (anciennes clés seulement) | expire seule (90 jours au plus) | (plus écrit ; supprimé par la purge et `purge-test-sends.ts`) |
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
| `relance_lock:{resend_id}` | string | Verrou « une seule relance » (valeur = clé d'idempotence de la relance) | 24 h | `/api/relance/send` |
| `relance_draft:{resend_id}` | JSON | Relance rédigée par Claude (`corps`, `generated_at`, `generated_by`) : une seule rédaction par mail | rétention RGPD, supprimée avec l'envoi | `/api/relance/generate` |
| `relance_gen_lock:{resend_id}` | string | Verrou de rédaction (un seul appel à Claude à la fois) | 180 s | `/api/relance/generate` |
| `slack_relance_attempts:{membre}` | compteur | Essais du DM J+3 quand Slack échoue | 7 jours | cron |
| `hubspot_retry` / `hubspot_retry:{id}` | sorted set / JSON | Notes HubSpot en échec à retenter (score = prochain essai) | membre retiré une fois traité / 7 jours | `/api/send`, relance, webhook, cron |
| `cache:deja_faites:{empreinte}` | JSON `{ at, value }` | Formations déjà suivies par un PS (record IDs), pour les formations proposées | 10 minutes | `/api/contact-history` (pré-calcul), `/api/generate` |
| `cache:airtable:fiches:v1`, `cache:airtable:formations:v1`, `cache:airtable:sessions:v1`, `cache:airtable:catalogue:v1` | JSON `{ at, value }` | Dernière version connue des tables Airtable lues en entier (rafraîchie en arrière-plan après 60 s / 5 min) | 30 jours | `lib/airtable.ts` (requêtes, `instrumentation.ts`) |
| `ratelimit:{action}:{email}:{fenêtre}` | compteur | Limites de débit | 10 minutes | génération, envoi |

Champs de `email_track` : les champs historiques (`contact_id`, `ps_nom`, `ps_email`, `commercial_name`, `formation_nom`, `sujet`, `statut`, `sent_at`, `opened_at`, `clicked_at`) sont conservés tels quels, si bien qu'une entrée v2 reste lisible par l'ancien code. Champs ajoutés :
`v` (2), `kind` (`initial` / `relance`), `sent_day`, `commercial_key`, `commercial_email`, `commercial_slack_id`, `commercial_hubspot_id`, `ps_rpps`, `ps_titre`, `ps_lastname`, `formation_numero`, `relance_due_day`, `sent_by` / `sent_by_name` (administrateur), `parent_id` (relance), `relance_id` / `relance_sent_at` (mail relancé), `slack_relance_at`, `click_notified_at`, `message_id`, `delivered_at`, `bounced_at`, `complained_at`, `first_opened_at`, `first_clicked_at`, `last_opened_at`, `open_count`, `click_count`, `auto_click_count`, et les drapeaux internes `counted_*` (un fait n'est compté qu'une fois).

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
- Le corps des mails (`email_body`) **n'est plus stocké** (minimisation RGPD : plus aucun usage depuis que la relance ne recopie plus le mail d'origine ; ni l'envoi ni la migration ne l'écrivent). Les clés existantes expirent seules (90 jours au plus) ; la purge RGPD et `purge-test-sends.ts` continuent de les supprimer.
- **Seul le KV est purgé** : les Notes HubSpot ne sont pas concernées.

### Migration des données (schéma v2)
**Procédure complète de mise en production, pas à pas : [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md)** (export → purge → migration → `--verify` → mise en ligne → seconde migration → `--verify` → `TRACKING_RELIABLE_SINCE` → dédoublonnage des Notes).

Le code fonctionne **avant et après** la migration :
- **avant** (`meta:schema_version` ≠ 2) : `/suivi` et l'export utilisent un **calcul de secours** sur les envois eux-mêmes (`runLegacyQuery`, `lib/suivi-query.ts`), avec la même règle de rattachement nom → email que la migration et les mêmes règles de comptage : les indicateurs ne sont jamais à zéro, et donnent les mêmes chiffres qu'après migration (vérifié) ;
- les événements webhook mettent à jour une ancienne entrée sans toucher aux compteurs (la migration la comptera, d'où l'absence de double comptage).

La migration reconstruit compteurs et index à partir des `email_track` existants et reprend les clés `relance:*`. **Seconde migration** (après la mise en ligne) : elle migre les envois faits entre-temps par l'ancien code et **rattrape** les envois déjà migrés que l'ancien code a modifiés (webhook ouverture / clic reçu par l'ancienne version : `first_*` repris, verrou de Note posé pour ne pas recréer la Note, statut remonté s'il a été rétrogradé, fait compté une seule fois — script `CATCHUP_SCRIPT`). `--verify` signale ces envois tant qu'ils ne sont pas rattrapés.

Résumé des commandes (détail et résultats attendus dans `docs/DEPLOIEMENT.md`). Chaque script affiche d'abord un rapport sans rien modifier : le lire avant de passer à l'écriture.
```bash
H=<hôte de la base KV de production>                                   # ex. xxx.upstash.io, vérifié contre KV_REST_API_URL

# 1. Sauvegarde complète (backups/kv-export-<hôte>-<date>.json) — obligatoire : les étapes 2 et 3 la refusent si elle a plus d'une heure
node scripts/migrate-kv.ts --host=$H --export

# 2. Suppression des envois de test (PS = TEST_HUBSPOT_CONTACT_ID ou TEST_PS_EMAIL), faits au nom de vrais commerciaux
node scripts/purge-test-sends.ts --host=$H                            #    rapport
node scripts/purge-test-sends.ts --host=$H --apply                    #    suppression

# 3. Migration v2 (compteurs, index, reprise des anciennes relances)
node scripts/migrate-kv.ts --host=$H --dry-run                        #    rapport (valider les noms « À VALIDER »)
node scripts/migrate-kv.ts --host=$H                                  #    migration

# 4. Contrôle : chaque fait compté une seule fois (aucune écriture, exit 1 au moindre écart)
node scripts/migrate-kv.ts --host=$H --verify

# 5. Notes HubSpot « Email ouvert » / « Email cliqué » en double
node scripts/dedupe-hubspot-notes.ts --host=$H                        #    rapport par contact (lire les cas ambigus)
node scripts/dedupe-hubspot-notes.ts --host=$H --apply                #    sauvegarde (backups/notes-archivees-*.json) puis archivage

# Retour arrière du KV si besoin (étapes 2 à 4) :
node scripts/migrate-kv.ts --host=$H --restore=backups/<fichier>.json            # plan, aucune écriture
node scripts/migrate-kv.ts --host=$H --restore=backups/<fichier>.json --confirm  # restauration
```
Avant l'étape 1 : ajouter `email.delivered`, `email.bounced` et `email.complained` sur l'endpoint du webhook dans Resend (voir « Webhooks Resend »). Les Notes HubSpot archivées à l'étape 5 restent récupérables 90 jours dans la corbeille HubSpot ; la restauration du KV ne les concerne pas.
- Node ≥ 22.18 (le script TypeScript s'exécute sans compilation ni dépendance).
- `.env.local` (ou `ENV_FILE=<fichier>`) doit contenir les `KV_REST_API_*` de la base visée, et `AIRTABLE_*`.
- **Idempotente** : une entrée déjà migrée est ignorée (sauf rattrapage d'une modification de l'ancien code) ; relancer la commande ne change rien.
- **Une seule entrée par mail** : la clé est le `resend_id` du mail. Chaque fait (reçu, ouvert, cliqué…) est compté une seule fois grâce aux marqueurs `counted_*`, même si des webhooks arrivent pendant la migration (testé). `--verify` recalcule les compteurs attendus à partir de ces marqueurs, les compare aux `stats:day:*` et contrôle la cohérence fait / comptage ; il sort en erreur au moindre écart.
- Deux mails réellement envoyés en double (avant l'idempotence) restent **deux** entrées : aucun mail envoyé n'est supprimé ni fusionné.

### Envois de test — `scripts/purge-test-sends.ts`
Supprime du KV les envois dont le PS est le contact de test (`TEST_HUBSPOT_CONTACT_ID`) ou l'adresse de test (`TEST_PS_EMAIL`), faits au nom de vrais commerciaux pendant les essais. Les deux variables (environnement ou `.env.local`) sont obligatoires : le script refuse de tourner sans elles.
- Supprimés pour chaque envoi : `email_track`, `email_body`, `email_clicks`, `send_result`, verrous `hubspot_note:*`, entrées de `emails_index`, `idx:commercial:*`, `idx:contact:*`, `relances_due` ; si l'envoi avait déjà été compté (entrée v2), sa contribution aux `stats:day:*` est retirée dans le même script atomique (`--verify` reste à 0 écart). Les anciennes clés `relance:*` du PS de test sont aussi supprimées.
- **Jamais touchés** : les envois vers d'autres PS, les Notes HubSpot.
- Garde-fous identiques à `migrate-kv.ts` : `--host` obligatoire, rapport par défaut, `--apply` pour écrire, refus sans export de moins d'une heure.

### Notes HubSpot en double — `scripts/dedupe-hubspot-notes.ts`
Avant la phase 1, le webhook créait une Note « Email ouvert » / « Email cliqué » à chaque événement. Le script archive les doublons (à lancer après la migration) :
```bash
node scripts/dedupe-hubspot-notes.ts --host=$H                 # rapport par contact, aucune modification (mode par défaut)
node scripts/dedupe-hubspot-notes.ts --host=$H --apply         # sauvegarde, puis archive les doublons
node scripts/dedupe-hubspot-notes.ts --restore=backups/notes-archivees-<hôte>-<date>.json   # recrée les Notes archivées
# options : --contact=<id> (un seul contact), --subject-prefix=<texte> (sujets commençant par…), --backup-dir=<dossier>
```
- **Sauvegarde avant tout archivage** : chaque Note à archiver (identifiant, contact, contenu, date affichée `hs_timestamp`, date de création, propriétaire) est écrite dans `backups/notes-archivees-<hôte>-<date>.json`, relue et vérifiée **avant** le premier appel d'archivage ; chaque lot archivé y est marqué (`archived_at`). Fichier à garder hors du dépôt (données personnelles, `backups/` ignoré par git).
- **Restauration** (`--restore=<fichier>`) : recrée chaque Note avec son contenu, sa date affichée, son propriétaire et son association au contact d'origine. HubSpot ne permet de reprendre ni l'identifiant ni la date de création (`hs_createdate`) : le nouvel identifiant est noté dans le fichier (`restored_id`). Relancer la commande après une interruption reprend sans doublon (Note déjà restaurée ou identique déjà présente : ignorée).
- **Limites d'appels HubSpot** : au plus 8 requêtes par seconde, lots de 100, nouvel essai sur 429 (délai `Retry-After`, sinon croissant) et sur erreur 5xx / réseau pour les lectures et l'archivage. Interruption de l'archivage : relancer la même commande (les Notes déjà archivées ne sont plus des doublons ; les suivantes sont sauvegardées dans un nouveau fichier).
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

## Modèle de rédaction

Le modèle utilisé pour toutes les rédactions (mail initial et relance) est défini à un seul endroit : `REDACTION_MODEL` dans `lib/config.ts` (actuellement `claude-opus-4-6`).

**Changer de modèle** : modifier `REDACTION_MODEL` (identifiant exact du modèle Anthropic), `npm run build`, tester une rédaction de mail et une rédaction de relance (`docs/TESTS.md`, sections M et L-bis), puis déployer. Aucun autre fichier à modifier.

**Relancer la comparaison des modèles** (`docs/comparaison-modeles.md`, comparaison du 8 octobre 2026) :
1. en local, avec la fiche et le contact de test, **sans envoyer de mail** ;
2. pour chaque modèle candidat et chaque cas (formations différentes, e-learning et classe virtuelle, avec et sans formations proposées), envoyer le prompt de production (`buildMailPrompt`, `lib/claude.ts`) en streaming, avec `max_tokens` 1500, et noter le délai avant le premier mot, la durée totale et les jetons (`usage`) ;
3. coût par mail = jetons d'entrée × tarif d'entrée + jetons de sortie × tarif de sortie (tarifs publics Anthropic par million de jetons) ;
4. contrôler le respect des consignes : 7 étapes d'inscription dans l'ordre (dont le code SMS), numéro DPC, dates et numéros des sessions, formations proposées avec leur lien (aucun lien inventé), signature complète, mention ANDPC, pas de tiret long ;
5. reporter les mails côte à côte dans `docs/comparaison-modeles.md` pour juger la qualité.

La comparaison du 8 octobre 2026 a utilisé une route temporaire de développement (supprimée ensuite, jamais livrée) : elle reconstruisait les cas avec les mêmes fonctions qu'en production (`getFormationsActives`, `getSessionsByFormation`, `getFormationsDejaFaites`, `getFormationsUpsell`) et écrivait chaque résultat dans un fichier local.

---

## Tests

Le protocole de test complet (prérequis, garde-fous, étapes, résultats attendus) est dans [`docs/TESTS.md`](docs/TESTS.md).
Les données de test se créent et se suppriment à la demande avec `scripts/seed-test.ts` (uniquement sur la base KV de **test**).

---

## Maintenance

### Ajouter un commercial
1. Airtable → table Commerciaux → ajouter un record
2. Renseigner : `hubspot_name`, `email` (**exactement l'adresse de son compte Google `@medere.fr`** : c'est elle qui rattache sa connexion à sa fiche), `phone`, `slack_user_id`, `hubspot_id`, `Statut="Actif"`
3. L'app le reconnaît en une minute environ (voir « Délai maximal de révocation », même mécanisme) ; il n'a qu'à se connecter avec son compte Google

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
6. Pas de DM attendu si une relance mail est déjà partie, en cas d'adresse invalide, de mail signalé comme indésirable, ou si le PS est inscrit (compteurs `skipped` de la réponse du cron)

### Le bouton « Relancer » est désactivé
La raison est affichée à côté : relance déjà envoyée, adresse invalide, signalé comme indésirable, mail d'un autre commercial (seul l'auteur ou un administrateur peut relancer), commercial du mail plus actif, ou compte en lecture seule.

### Une alerte « Note HubSpot non créée (échec définitif) » est arrivée
La Note a été retentée 4 fois sur environ 18 heures. Vérifier `HUBSPOT_TOKEN` et le scope `crm.objects.notes.write`, puis recréer la Note à la main sur la fiche du contact indiquée dans l'alerte (le texte de l'envoi est dans `/suivi`).

### Le webhook Resend ne met pas à jour le statut
1. resend.com → Webhooks → vérifier que l'URL est correcte
2. Vérifier `RESEND_WEBHOOK_SECRET` dans les env vars Vercel (signature invalide → 400 + log `[WEBHOOK] Signature invalide`)
3. Logs Vercel → chercher `[WEBHOOK]`

### Erreur 500 sur /api/sessions
Vérifier que le champ `Format` est bien dans les fields chargés dans `getSessionsByFormation`.

### « Service momentanément indisponible. Préviens Déthié. » (erreur 500)
`NEXTAUTH_SECRET` ou `CRON_SECRET` est absent des variables d'environnement. Logs : `[AUTH] NEXTAUTH_SECRET manquant` ou `[CRON] CRON_SECRET manquant`.

### Un commercial ne peut plus se connecter ou voit « Ton accès à l'Agent Mail a été désactivé »
1. Vérifier que son compte Google Workspace `@medere.fr` est actif
2. Vérifier que son `Statut` est `Actif` dans Airtable Commerciaux (effet en une minute environ, voir « Délai maximal de révocation »)
3. « Ton compte n'est pas associé à une fiche commercial » : l'`email` de sa fiche doit être exactement l'adresse de son compte Google (logs `[IDENTITE]`)
4. « La connexion a expiré ou a été interrompue » : recommencer la connexion (le `state` OAuth expire après 10 minutes)

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
