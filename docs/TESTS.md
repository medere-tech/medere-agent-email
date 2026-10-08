# Protocole de test — Agent Mail DPC

Ce protocole valide en conditions réelles, en local, la fiabilité des données (envoi, tracking, relances, webhooks) et l'interface.
Il ne dépend d'aucune donnée laissée en place : les données nécessaires sont créées par `scripts/seed-test.ts` puis supprimées.

---

## 1. Prérequis

| Élément | Valeur attendue |
|---|---|
| Branche | celle à valider (jamais `main` directement) |
| `.env.local` | complet (voir README) — **`KV_REST_API_URL` pointe sur la base Upstash de TEST** |
| Contact HubSpot de test | un seul contact dédié (ex. `18421683158`, adresse `dethie@medere.fr`) |
| Adresse de réception | uniquement l'adresse du contact de test |
| Slack | le `slack_user_id` du testeur (les DM de relance n'arrivent qu'à lui) |
| Fiche commercial de test | « Dethie Faye » (`recubd9fXVX2rkhfB`, `dethie@medere.fr`, owner HubSpot `176772849`, Slack `U05UVHGBURX`, Statut Actif) — la session Google `dethie@medere.fr` est **administrateur** |
| Node | ≥ 22.18 (exécute `scripts/seed-test.ts` sans dépendance) |
| Navigateur | profil Chrome **« Tests Claude »** (uniquement l'extension Claude), qui apparaît sous le nom **« Browser 1 »** dans `/chrome` ; session Google @medere.fr ouverte sur `http://localhost:3000`. Les tests d'interface et les captures se font dans ce profil (dans l'autre profil, « Browser 2 », les captures échouent). Fenêtre visible à l'écran pendant les tests. |

Variables à exporter pour le script de seed :

```bash
export TEST_KV_HOST=<hôte-de-la-base-kv-de-test>   # ex. close-imp-209245.upstash.io
export TEST_HUBSPOT_CONTACT_ID=18421683158
export TEST_PS_EMAIL=dethie@medere.fr
export TEST_SLACK_USER_ID=<slack-id-du-testeur>
```

---

## 2. Garde-fous (non négociables)

1. **Base KV** : vérifier l'hôte avant tout (`grep KV_REST_API_URL .env.local`). Le script de seed refuse toute base dont l'hôte ≠ `TEST_KV_HOST`. En cas de doute : arrêter.
2. **Destinataires** : le « PS » et le « commercial » de test sont tous deux le contact de test. Aucun mail vers une autre adresse, aucune Note sur un autre contact.
3. **Commercial de test** : tous les envois se font avec la fiche « Dethie Faye ». Ne jamais envoyer au nom d'un vrai commercial (sa copie et ses DM partiraient chez lui). Pour tester l'administrateur au nom d'un autre commercial : **génération seule**, jamais d'envoi. Depuis le lot 2, l'identité est relue côté serveur : l'ancienne injection depuis la console n'a plus d'effet.
4. **Sujets** : préfixer chaque sujet de test par `[TEST-…]` pour retrouver (et nettoyer) les mails sans lire les autres.
5. **Variables faussées** : sauvegarder `.env.local` et son SHA-256 avant de commencer ; restaurer chaque variable faussée **immédiatement** après le test ; vérifier le SHA-256 à la fin.
   - Les routes rechargent `.env.local` à chaud, **pas le middleware** : pour un test qui touche `NEXTAUTH_SECRET`, redémarrer `npm run dev`.
6. **Webhook Resend de production** : ne jamais le modifier. Les tests de webhook se font avec des événements **signés localement** (`seed-test.ts webhook …`).
7. **Rien n'est commité / poussé** pendant les tests.

---

## 3. Mise en place

```bash
cp .env.local /chemin/hors-repo/env.backup && sha256sum .env.local   # noter l'empreinte
# Export de référence de la base de TEST : sert au nettoyage final (§5)
node --no-warnings scripts/migrate-kv.ts --host=$TEST_KV_HOST --export
npm run dev                                                          # http://localhost:3000 (vérifier le port affiché)
node --no-warnings scripts/seed-test.ts seed            # entrées test-seed-envoye et test-legacy (format d'avant v2)
# --relance : relance:test-seed-today (rattachable à test-seed-envoye) + relance:test-seed-orphan
# --names   : test-legacy-kaoufer (→ kaoufer@medere.fr) et test-legacy-loane (→ nom:loane-deluge)
```

> Vérifier qu'aucun autre `next dev` du dépôt ne tourne déjà (`localhost:3000` occupé → le serveur démarre sur 3001, et deux serveurs partagent le même dossier `.next`).
> **Avant tout test qui peut envoyer un DM Slack** (cron, webhook de clic à partir du lot 3) : `node --no-warnings scripts/seed-test.ts check-slack`. La commande refuse (exit 1) si une clé de la base de test contient un identifiant Slack autre que `TEST_SLACK_USER_ID` (une relance laissée par un test manuel peut porter le `slack_user_id` d'un vrai commercial).
> Rejouer exactement le même événement webhook (test du dédoublonnage) : `seed-test.ts webhook opened <id> --svix-id=<suffixe>` deux fois.
> En fin de lot : `npm run build` doit réussir (arrêter d'abord `npm run dev`, les deux écrivent dans `.next`).

---

## 4. Tests

Pour chaque test : noter ce qui a été fait, le résultat attendu, le résultat obtenu (log, extrait KV, capture), OK / ÉCHEC.
Un échec → corriger, `npx tsc --noEmit && npx next lint`, puis **refaire tous les tests de l'action**.

### A. Envoi : copie commerciale (pas de BCC)

| # | Étapes | Attendu |
|---|---|---|
| A1 | Envoyer un mail `[TEST-A]` depuis l'UI | 2 mails reçus (PS + copie), 2 `email_id` distincts, `bcc: null` (dashboard ou API Resend) |
| A2 | Lire le KV | seul l'`email_id` du PS a un `email_track:*` ; `emails_index` +1 |
| A3 | `seed-test.ts webhook opened <id-copie>` puis `clicked` | 200, log « email_id non trouvé dans KV », statut du mail PS inchangé, aucune Note |
| A4 | Faire échouer la copie seule (collision de clé d'idempotence : envoi 1 avec la clé `X-copie`, envoi 2 avec la clé `X` et un autre sujet) | envoi 2 → 200, mail PS reçu, log `[SEND] Copie commercial non envoyée` |

### B. Idempotence

| # | Étapes | Attendu |
|---|---|---|
| B1 | Double clic (ou 2 `click()` dans le même tick) sur « Envoyer » | 1 seul `POST /api/send` |
| B2 | Rejouer la même requête (même clé, même corps) | 200 `replay: true`, même `resend_id` ; aucun nouveau mail / Note / relance |
| B3 | Rejouer avec le sujet modifié | 409 « déjà en cours d'envoi ou a déjà été envoyé » |
| B4 | « Nouveau mail » puis envoi | nouvelle clé, nouvel envoi |
| B5 | Fausser `KV_REST_API_TOKEN`, envoyer | 200, mail reçu, log `[SEND] Tracking KV non enregistré` — **restaurer** |
| B6 | Fausser `RESEND_API_KEY`, envoyer | 500, aucune écriture KV — **restaurer** |

### C. Cron de relance

Créer une clé `relance:*` datée du jour (`--relance` du seed, ou à la main) puis :
`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/relance`

| # | Cas | Attendu |
|---|---|---|
| C1 | PS réellement inscrit (RPPS) | `notified: 0`, clé supprimée |
| C2 | Même PS sans RPPS (retrouvé par email dans Clients) | `notified: 0` |
| C3 | PS non inscrit (contact de test) | `notified: 1`, DM reçu par le testeur |
| C4 | `AIRTABLE_TOKEN` faussé | `notified: 1` + `errors[]` « vérification inscription impossible » — **restaurer** |
| C5 | Upsell : générer pour une formation F avec la date de fin juste avant la prochaine session d'une formation D déjà faite par un PS ; témoin sans RPPS puis test avec RPPS | D proposée dans le témoin, **absente** avec le RPPS |
| C6 | `CRON_SECRET` absent (même avec `Bearer undefined`) | 500 + log `[CRON] CRON_SECRET manquant` — **restaurer** ; mauvais secret → 401 |

### D. Webhook

| # | Étapes (`seed-test.ts webhook …`) | Attendu |
|---|---|---|
| D1 | `opened test-seed-envoye` | statut `ouvert`, `first_opened_at` = `opened_at`, `clicked_at: null` conservé, 1 Note « ouvert » |
| D2 | 3 × `opened` de plus | dates inchangées, aucune nouvelle Note |
| D3 | `clicked` puis `opened` | statut `cliqué` et le reste, 1 Note « cliqué » |
| D4 | Rejouer le même `svix-id` | log « Événement déjà traité » |
| D5 | Signature invalide | 400 |
| D6 | `HUBSPOT_TOKEN` faussé puis `opened` sur un mail neuf ; restaurer puis `opened` | 200 + KV mis à jour sans Note ; puis Note créée |
| D7 | `opened test-legacy` puis `clicked test-legacy` | `first_opened_at` repris de `opened_at`, verrou `legacy`, **pas** de Note « ouvert » ; Note « cliqué » créée |
| D8 | Ouvrir `/suivi` | toutes les entrées lisibles (y compris `test-legacy`), stats cohérentes |

### E. Erreurs visibles dans l'UI

| # | Étapes | Attendu |
|---|---|---|
| E1 | `HUBSPOT_TOKEN` faussé, recherche de contact | bandeau rouge « HubSpot indisponible, ne crée pas le contact », pas de message orange — **restaurer** |
| E2 | Nom inexistant, HubSpot OK | message orange « Aucun contact trouvé » |
| E3 | Passer l'étape 1, fausser `AIRTABLE_TOKEN`, cliquer « Continuer » | bandeau « Impossible de charger la liste des formations. Réessaie dans quelques instants. » (aucun code technique affiché ; détail dans le log `[FORMATIONS]`) |
| E4 | Formations chargées, fausser `AIRTABLE_TOKEN`, choisir une formation | bandeau « Impossible de charger les sessions. Réessaie dans quelques instants. » — **restaurer** |
| E5 | Requête `/api/generate` sans cookie (`credentials: 'omit'`) | « Session expirée, reconnecte-toi. » |

### F. Pagination, session, déconnexion, secrets, formations

| # | Étapes | Attendu |
|---|---|---|
| F1 | Charger `/api/formations` et `/api/sessions` 4 fois à < 60 s d'intervalle | toujours 200, mêmes nombres, aucun 422 `LIST_RECORDS_ITERATOR_NOT_AVAILABLE` |
| F2 | Se reconnecter, inspecter le cookie `medere_session` (DevTools → Application) | expiration ≈ connexion + 7 jours (même durée pour le JWT). Rappel : la session n'est pas révocable — un compte Google désactivé garde l'accès jusqu'à 7 jours ; seule la rotation de `NEXTAUTH_SECRET` coupe toutes les sessions |
| F3 | « Se déconnecter » sur `/` puis sur `/suivi` | `POST /api/auth/logout` → 303 → `/login` ; `/` redirige vers `/login` ; `GET /api/auth/logout` → 405 ; ancienne route `/api/auth/callback/google/logout` → 404 |
| F4 | Retirer `NEXTAUTH_SECRET`, **redémarrer** `npm run dev` | `/` et `/api/*` → 500 « Service momentanément indisponible. Préviens Déthié. » + log `[AUTH] NEXTAUTH_SECRET manquant` ; `/login` reste en 200 ; callback → 500 — **restaurer et redémarrer** |
| F5 | `/api/formations` avec `FORMATIONS_REQUIRE_FUTURE_SESSION = false` | même nombre qu'un comptage Airtable `Active` + numéro DPC |
| F6 | (optionnel) passer la constante à `true` | uniquement les formations avec session future ; **remettre `false`** |

### H. Fondations des données (schéma v2)

Webhooks : `seed-test.ts webhook <delivered|bounced|complained|opened|clicked> <id> [--created-at=<iso>] [--message-id=<id>]`.
Compteurs : `HGETALL stats:day:<jour d'envoi>` ; entrée : `GET email_track:<id>`.

| # | Étapes | Attendu |
|---|---|---|
| H1 | Envoi réel `[TEST-H]` | `email_track` avec `v: 2`, `sent_day`, `commercial_key` ; `email_body` (TTL ≈ 90 j) ; membre dans `emails_index`, `idx:commercial:<email>`, `idx:contact:<id>`, `relances_due` (score = J+3 00:00 UTC) ; `stats:day` : `sent` +1 et `sent\|<email>` +1 ; plus aucune clé `relance:*` créée |
| H2 | `delivered --message-id=<x>` sur H1 | statut `délivré`, `delivered_at`, `message_id` ; `delivered` +1 |
| H3 | `delivered` puis `opened --created-at=<livraison + 1 s>` | ouverture **humaine** : statut `ouvert`, `opened` +1, 1 Note « Email ouvert » |
| H4 | 2 × `opened` de plus | `first_opened_at` figé, `last_opened_at` mis à jour, `open_count: 3` ; `opened` +1 une seule fois ; 1 seule Note |
| H5 | Un `clicked` isolé | humain : statut `cliqué`, `clicked` +1 ; Note « 🖱️ Email cliqué le… » créée ~3 s après |
| H5b | Rafale (`seed --clicks`) : 3 `clicked` **en parallèle** sur 3 liens différents, `--click-at` à 0 / 0,4 / 0,8 s | les 3 clics `AUTO(rafale)` dans `email_clicks`, `click_count: 0`, `auto_click_count: 3`, statut `délivré`, `clicked` et `opened` inchangés, log « Premier clic reclassé automatique, Note non créée » |
| H5c | Même rafale, ordre d'arrivée inversé | même résultat |
| H5d | Même lien cliqué 2 fois en 0,5 s | 2 clics humains, `click_count: 2`, 1 Note |
| H5e | `--ua='…HeadlessChrome…'` puis `--ua=` (vide) | `AUTO(robot)`, compteurs inchangés |
| H5f | Clic humain bien après une rafale | compté, 1 Note |
| H5g | Limite : clic humain (Note créée), puis 2e lien à +1 s arrivé 2 s plus tard | les 2 reclassés, compteurs et statut corrigés ; la Note reste (limite documentée) |
| H6 | `bounced` sur un autre envoi déjà ouvert | statut `bounce` (prioritaire), `bounced` +1 ; puis `opened` → statut reste `bounce` |
| H7 | `complained` | statut `plainte`, `complained` +1 |
| H8 | Webhooks sur `test-legacy` **avant** migration | entrée mise à jour, verrou `legacy`, aucune Note « ouvert », **aucun** compteur modifié |
| H9 | `/suivi` avant migration | toutes les entrées lisibles, stats calculées sur les entrées ; badges Délivré / Bounce / Plainte |
| H10 | `migrate-kv.ts --dry-run` (après `seed --relance --names`) | rapport : compteurs par jour, commerciaux, « À VALIDER » (`Commercial de test`, `Loane Deluge`), relances rattachées / legacy ; **DBSIZE inchangé** |
| H11 | `--host` faux ; migration sans export de moins d'une heure (`--backup-dir` vide) | les deux refusées (exit 1) |
| H12 | `--export` puis migration réelle | entrées en `v: 2`, compteurs et index créés, `relance:test-seed-today` rattachée et supprimée, `legacy:relance:test-seed-orphan` dans `relances_due`, `meta:schema_version = 2` |
| H13 | Relancer la migration ; comparer deux exports avant / après | « 0 envoi(s) migré(s) », aucune différence de valeur (hash comparés sans ordre) |
| H13b | `migrate-kv.ts --verify` après tous les tests de webhooks | « Écarts de compteurs : 0 », « Incohérences fait / comptage : 0 » |
| H13c | Migration lancée **pendant** une salve de webhooks parallèles (`opened` + `clicked` sur 5 envois), puis `--verify`, 2e migration, `--verify` | 0 écart, 0 incohérence |
| H14 | `--restore=<export H12>` sans puis avec `--confirm` | plan sans écriture ; puis base identique à l'export (clés, valeurs, TTL) |
| H15 | Webhooks sur `test-legacy` **après** migration | aucune nouvelle Note « ouvert », compteurs non doublés |
| H16 | `/suivi` après migration | stats = somme des `stats:day:*` ; mêmes chiffres qu'avant migration |
| H17 | Purge : entrée de test datée de 1 100 jours (score de `emails_index` + entrées d'index), puis appel du cron | `purged: 1`, `email_track`, `email_body`, verrous et membres d'index supprimés ; les autres envois intacts |

### I. Notes HubSpot en double (`scripts/dedupe-hubspot-notes.ts`) — contact de test uniquement

Créer sur le contact de test des Notes `[TEST-DEDUP]` au format de l'agent + les entrées KV correspondantes : mail A (3 « Email ouvert », 2 « Email cliqué » + 1 « Lien cliqué », 2 « Email envoyé »), deux mails au même sujet B (2 « Email ouvert »), mail C (1 Note), 2 Notes manuelles « pièges » reprenant les mêmes mots.
Toujours avec `--contact=<contact de test> --subject-prefix="[TEST-DEDUP]"`.

| # | Étapes | Attendu |
|---|---|---|
| I1 | Rapport (sans `--apply`) | A : garde la plus ancienne ouverture et le plus ancien clic, 4 à archiver ; B signalé AMBIGU ; C, pièges, « Email envoyé » absents du rapport ; aucune modification |
| I2 | `--host` faux | refus, exit 1 |
| I3 | `--apply` | 4 Notes archivées (404 en lecture), toutes les autres présentes ; mails du KV intacts |
| I4 | 2e passage | « 0 doublon(s) », B toujours ambigu |

### J. Envois de test (`scripts/purge-test-sends.ts`) — base KV de test uniquement

Données : `seed --relance --names --purge` (envois au PS de test au nom de « Commercial de test », Kaoufer, Loane et Zacharie, dont un repéré par l'adresse seule ; 2 envois à un PS fictif `99999999999` / `ps.fictif@example.invalid` par Zacharie et Sarah ; anciennes relances des deux PS).
> Ne pas envoyer de webhook sur les envois du PS fictif : le webhook tenterait une Note HubSpot sur un contact inexistant (HubSpot la refuse, l'erreur est journalisée).

| # | Étapes | Attendu |
|---|---|---|
| J1 | Rapport (avant migration) | 6 envois du PS de test listés par commercial, 3 anciennes relances ; 2 envois et 1 relance du PS fictif conservés ; aucune modification |
| J2 | `--apply` avec `--backup-dir` vide | refus, exit 1 |
| J3 | `--export` puis `--apply` | restent : les 2 envois du PS fictif, `emails_index` à 2 membres, `relance:test-autre-ps` ; migration puis `--verify` à 0 écart |
| J4 | Après migration : ouvertures / clics sur des envois du PS de test, `--verify` (0), purge `--apply`, `--verify` | contributions décomptées, 0 écart ; compteurs du PS fictif inchangés (y compris par commercial) ; `idx:contact:18421683158` supprimé, `idx:contact:99999999999` intact |

### K. Identité et sécurité (lot 2)

| # | Étapes | Attendu |
|---|---|---|
| K0 | Fonctions pures de `lib/roles.ts` (rôles, expéditeur) et `buildSentNoteBody` exécutées avec Node | tous les cas conformes (admin, commercial, lecteur, inactif, identifiant forgé, fiche inactive, Note avec / sans « Envoyé par ») |
| K1 | `GET /api/me` (session `dethie@medere.fr`) | `role: admin`, fiche `recubd9fXVX2rkhfB` |
| K2 | Étape 1 en administrateur | fiche Dethie Faye présélectionnée, liste des commerciaux actifs modifiable |
| K3 | `POST /api/generate` avec `commercial_id` de Zacharie (**génération seule**) | 200, signature de Zacharie, log `[GENERATE] Génération par … au nom de …` |
| K4 | `commercial_id` d'une fiche « Plus actif » | 400 « Ce commercial n'est pas actif… » |
| K5 | Ancien objet `commercial: {…}` forgé, sans `commercial_id` | ignoré : signature Dethie Faye |
| K6 | `ADMIN_EMAILS` vidé (annexe §6) : `/api/me`, étape 1, `generate` et `send` au nom de Zacharie | `role: commercial` ; étape 1 verrouillée « Ton compte » ; 403 « Tu ne peux générer et envoyer des mails qu'en ton nom. » — **remettre `ADMIN_EMAILS`** |
| K7 | Envoi réel `[TEST-L2]` en commercial | `email_track` : nom, email, Slack `U05UVHGBURX`, owner `176772849` relus dans Airtable, pas de `sent_by` ; Note sans « Envoyé par » |
| K8 | Fiche `recubd9fXVX2rkhfB` → « Plus actif » (connecteur Airtable : le jeton de l'app est en lecture seule), interroger `/api/me`, `/api/generate`, `/api/suivi`, `/api/send` toutes les 4 s | tout en 403 en 61 s au plus (fiches rafraîchies en arrière-plan, aucune requête ne dépasse 300 ms) ; accueil et `/suivi` affichent « Ton accès à l'Agent Mail a été désactivé… » — **remettre « Actif »**, accès rétabli en moins de 60 s |
| K9 | 31 `generate` puis 21 `send` invalides (aucun appel à Claude, aucun envoi) | 30 × 400 puis 429 « … limite de 30 générations… » ; 20 × 400 puis 429 « … limite de 20 envois… » — vider `ratelimit:*` |
| K10 | `/api/auth/login` ×2 ; callback sans cookie, sans `state`, avec `state` différent, avec `state` identique et code faux | 307 vers Google avec `state` différent à chaque fois + cookie httpOnly `Path=/api/auth` ; `invalid_state` ×3 ; `server_error` (state accepté, code refusé) ; cookie effacé |
| K11 | Connexion Google réelle (déconnexion puis « Se connecter avec Google ») | retour sur `/`, session créée |
| K12 | Performance en mode production local (`npm run build` puis `npm run start`) | sessions, formations et recherche de contact < 500 ms (cache chaud) |

### L. Relances, DM et alertes (lot 3)

Données : `seed --relances` (envois de la fiche Dethie Faye, relance J+3 due : non ouvert il y a 2 jours, ouvert, cliqué, adresse invalide, indésirable, déjà relancé, sans Slack ; un envoi de « Zacharie » sans échéance ; une ancienne relance `legacy:`). **Avant chaque appel du cron : `check-slack`.** Sujets d'envoi réel tous distincts (`[TEST-L3-A]`, `[TEST-L3-B]`…).

| # | Étapes | Attendu |
|---|---|---|
| L0 | Tests Node de `renderMail` (19 cas) | échappement, liens Markdown et URL sans lien imbriqué, ponctuation finale exclue, parenthèses, texte brut |
| L1 | Recherche de contact (étape 4) | première liste affichée dès la première passe, contacts supplémentaires ajoutés à la suite, ordre conservé, sélection conservée |
| L2 | Rôle lecteur (`ADMIN_EMAILS` vidé + email de la fiche changé temporairement par le connecteur Airtable) | accueil « pas associé à une fiche commercial » ; `/suivi` lisible, « Relancer » désactivé (« Ton compte ne permet pas… ») ; generate, send, relance (préparer, rédiger, envoyer) → 403 — **tout remettre, relire la fiche, vérifier le diff** |
| L3 | `GET /api/relance?id=` sur non ouvert / ouvert / cliqué | objet « Relance : votre formation … » ; brouillon **identique** pour les 3 statuts (hors date d'envoi), introduction neutre, sessions, 7 étapes, signature ; pas de mail d'origine recopié |
| L4 | Adresse invalide, indésirable, déjà relancé, inconnu | 409 / 409 / 409 / 404, messages lisibles |
| L6 | Administrateur sur un mail de Zacharie (**préparation seule**) ; même mail en rôle commercial | 200 « au nom de Zacharie » ; 403 « Seul le commercial qui a envoyé ce mail… » (préparer et envoyer) |
| L7 | Envoi réel `[TEST-L3-A]`, `opened`, puis `/suivi?relance={id}` | fenêtre ouverte directement, pré-remplie « ouvert, sans clic » ; « Rédiger la relance » remplace le texte |
| L8 | Objet préfixé `[TEST-L3-B]`, « Envoyer la relance » | 200 `in_reply_to: true` ; KV : `relance_id` sur l'origine, relance `kind: relance` + `parent_id`, origine retirée de `relances_due`, `relance_sent` +1 ; Gmail (source) : `In-Reply-To` = `References` = Message-ID de l'origine (Resend), multipart avec texte brut |
| L9 | Rejeu même clé ; autre clé ; nouvelle préparation | rejeu 200 `replay: true` même relance ; 409 ; 409 ; `/suivi` : « Relancé », relance sous le mail, plus de bouton |
| L10 | Cron (×2) | 1er : `notified: 4` (rattrapage compris), `skipped` adresse invalide / indésirable / relance mail = 1, 1 erreur « pas d'identifiant Slack » → DM d'alerte ; 2e : rien. DM reçus par le testeur seul, avec statut et lien `/suivi?relance=` |
| L11 | Clic humain, 2e clic, rafale sur un autre envoi | 1 seul DM « vient de cliquer » ; aucun pour le 2e clic ni la rafale |
| L12 | `HUBSPOT_TOKEN` faussé : 2 Notes en échec, cron avec échéance forcée ×3 ; jeton restauré, cron | file `hubspot_retry` (essais 1 → 3) ; 4e essai : Note abandonnée + DM « échec définitif » + récapitulatif ; après restauration : Note créée, file vide — **SHA-256 de `.env.local` identique** |
| L13 | Performance (production locale) | première passe de recherche ~280–330 ms côté API ; premier résultat affiché ~780–1 040 ms après la frappe (dont 350 ms d'attente de frappe) |

### L-bis. Relance : une seule rédaction par Claude par mail

Données : `seed --relances`. Journaux du serveur : « Appel à Claude pour la relance de … », « Brouillon déjà rédigé renvoyé, sans appel à Claude », « Rédaction déjà en cours, attente du brouillon ».

| # | Étapes | Attendu |
|---|---|---|
| LB1 | `/suivi?relance=test-rel-ouvert`, « Rédiger la relance » | texte remplacé ; le bouton disparaît, « Rédigée · modifiable à la main » ; `relance_draft:test-rel-ouvert` créé |
| LB2 | Recharger la page | pas de bouton, même texte (`redigee: true`) |
| LB3 | `POST /api/relance/generate` direct (même mail) | 200 `dejaRedigee: true`, même texte ; journal « déjà rédigé », **aucun** « Appel à Claude » |
| LB4 | Deux `POST` simultanés sur `test-rel-clique` | deux 200, même texte ; **un seul** « Appel à Claude », une « attente du brouillon » |
| LB5 | `ANTHROPIC_API_KEY` faussée (sauvegarde de `.env.local`), `POST` sur `test-rel-non-ouvert` ; clé restaurée, nouveau `POST` | 500 « La rédaction de la relance a échoué. Réessaie. », ni verrou ni brouillon ; puis 200, texte rédigé — **SHA-256 de `.env.local` identique** |

### M. Aperçu, liens, déjà contacté, rédaction au fil de l'eau (lot 5)

Contrôles par lecture de la page (DOM). Données : `seed --historique` (contact de test : envois il y a 2 jours, 6 jours + relance à 4 jours, 20 jours ; un envoi récent à un autre contact).

| # | Étapes | Attendu |
|---|---|---|
| M0 | Tests Node : `linkWarnings` et `parseGeneratedMail` (25 cas) + `renderMail` (19 cas) | tous OK |
| M1 | Étape 4, choisir le contact de test | « Déjà contacté ces 14 derniers jours » : 3 lignes (mail Dethie Faye / Ouvert, relance Zacharie / Reçu, mail Zacharie / Cliqué), du plus récent au plus ancien ; ni l'envoi de 20 jours ni l'autre contact |
| M2 | « Générer le mail » | l'étape 5 s'ouvre tout de suite, l'objet puis le texte s'écrivent progressivement (dizaines de mises à jour) ; champs en lecture seule et envoi désactivé pendant la rédaction |
| M3 | Onglet « Aperçu » | De / À / Objet, liens cliquables (`https://www.agencedpc.fr/professionnel/`), aucun lien imbriqué |
| M4 | Ajouter « [Lien d'inscription] », « htps://medere.fr », « www.agencedpc/pro », « [le site](medere.fr) », « [ok](https://medere.fr) » | 4 avertissements (le lien correct n'en a pas) ; texte d'origine remis → plus d'avertissement |
| M5 | Envoi réel `[TEST-L5-A]` ; comparer l'aperçu au HTML lu chez Resend | **identique** |
| M6 | Nouveau mail, « Retour » pendant la rédaction | retour à l'étape 4 sans erreur, contact conservé, aucune erreur dans les journaux |
| M7 | `ANTHROPIC_API_KEY` faussée, « Générer le mail » ; clé restaurée | retour à l'étape 4 avec « La rédaction du mail a échoué. Réessaie. » — SHA-256 identique |
| M8 | Fenêtre de relance : ajouter « https:/medere.fr » | avertissement « Adresse mal écrite » |
| M9 | Performance (production locale) | voir le rapport du lot 5 |

### R. Validation finale avant déploiement (simulation sur la base de test)

Données : `node scripts/seed-test.ts seed-prod` — 90 envois **au format de la production actuelle** (code de `main` : `email_track` minimal, `emails_index`, `relance:*`, aucun compteur ni `meta:schema_version`), 4 commerciaux (dont un nom sans fiche correspondante), 12 envois de test vers le contact de test au nom de plusieurs commerciaux, relance orpheline. Relevé de `/suivi` (6 périodes × équipe, « Mes envois », chaque commercial) à chaque étape. **Aucun envoi.**

| # | Étape | Attendu |
|---|---|---|
| R1 | Base non migrée | calcul de secours : indicateurs non nuls sur toutes les périodes ayant des envois ; rattachement des noms identique à la migration |
| R2 | `--export` | chiffres inchangés |
| R3 | `purge-test-sends.ts` (rapport puis `--apply`) | uniquement les 12 envois de test et leurs `relance:*` ; total 60 j : 90 → 78 |
| R4 | `--dry-run`, migration, `--verify` | `/suivi` **identique** avant / après migration ; 0 écart |
| R5 | `dedupe-hubspot-notes.ts --contact=18421683158` (rapport) | aucun doublon, aucun cas ambigu |
| R6 | `seed-prod --old-writes` (ancien code encore actif : 3 envois au format ancien + `relance:*`, 6 webhooks ouverture / clic sur des envois migrés dont une ouverture sur un envoi cliqué) | `--verify` signale les envois modifiés ; compteurs en retard sur la liste (attendu dans cette fenêtre) |
| R7 | Export, `--dry-run`, seconde migration, `--verify` | « 3 à migrer, 6 à rattraper », 0 écart ; statut « cliqué » rétabli, verrou de Note posé ; équipe = liste sur toutes les périodes ; compteurs identiques au calcul de secours (marqueur de migration retiré un instant) |
| R8 | Bout en bout, dans l'ordre réel | déconnexion / connexion Google, étapes 1 à 6, envoi `[TEST-L6-A]`, ouverture, clic, DM premier clic, `/suivi` filtres et période, export, relance par mail `[TEST-L6-B]`, cron (5 DM dont rattrapage, rien au 2ᵉ passage), révocation (403 en 60 s, retour 200 en 32 s), déconnexion (API redirigées vers `/login`) |

### Q. Page /suivi (lot 4)

Données : `node scripts/seed-test.ts seed-suivi` (60 envois sur ~48 jours, 3 commerciaux, 4 formations, tous les statuts, 16 relances, compteurs journaliers cohérents) et `seed --historique`. Résultats attendus calculés indépendamment en lisant le KV (filtre en Node sur les entrées), puis comparés à `POST /api/suivi`. Production locale. **Aucun envoi.**

| # | Étapes | Attendu |
|---|---|---|
| Q1 | 11 combinaisons : 30 j équipe, « Mes envois », un commercial, statut Cliqué, une formation, recherche « helene » et « LEFÈVRE », commercial + statut, 7 j, mois dernier, 60 j | total, ouverts, cliqués et premier envoi identiques au calcul indépendant ; pagination (page 3) dans l'ordre ; facettes formations = total de la période ; `GET /api/suivi` → 405 |
| Q2 | Indicateurs | « Équipe » et « Mes envois » (compteurs journaliers) égaux aux valeurs calculées sur les entrées |
| Q3 | Rôles | administrateur : « Mes envois » désactivé par défaut ; commercial (`ADMIN_EMAILS` vidé temporairement) : activé, filtre commercial grisé |
| Q4 | `TRACKING_RELIABLE_SINCE` fixé temporairement au 20/09/2026 | avertissement sur 30 j et mois dernier, absent sur 7 j ; `null` : jamais |
| Q5 | Export CSV de la vue | BOM, `text/csv`, 13 colonnes, autant de lignes que de mails dans la vue |
| Q6 | Onglet caché plus de 60 s, puis de nouveau visible | aucune requête pendant qu'il est caché ; une requête immédiate au retour |
| Q7 | Temps (repère `data-vue` / `data-etat` sur le tableau) | changement de filtre affiché en moins de 300 ms ; période déjà préchargée : quelques dizaines de ms |
| Q8 | Captures ordinateur et mobile (390 px) | design zinc, aucun débordement horizontal, nom du PS lisible, ligne ouverte (relance sous le mail d'origine, bouton « Relancer ») |

### P. RGPD : aucune mention du suivi dans les textes envoyés aux PS

Données : `seed --relances`, puis les 3 envois `test-rel-non-ouvert` / `-ouvert` / `-clique` rattachés à une vraie formation (n° 92622525450) avec un corps d'origine à l'ancien parcours ; un brouillon rédigé à l'ancien format (sans `v: 2`) sur `test-rel-ouvert`. **Aucun envoi.**

| # | Étapes | Attendu |
|---|---|---|
| P1 | `GET /api/relance` sur les 3 envois | brouillons identiques (hors date d'envoi) ; l'ancien brouillon rédigé est ignoré |
| P2 | `POST /api/relance/generate` sur les 3 envois | 200 ; aucune formulation interdite (« j'ai vu », « pris connaissance », « avez ouvert », « consulté », « avez lu », « temps de lire », « cliqué », « ouverture »…) ; introduction neutre identique ; 7 étapes dans l'ordre avec la phrase SMS ; sessions et numéro DPC ; signature ; ni « Mon précédent message » ni ancien parcours |
| P3 | Lecture du code | `generateRelance` ne reçoit plus le statut ni le mail d'origine (`GenerateRelanceParams`) ; `NO_TRACKING_RULE` dans les prompts du mail et de la relance |

### O. Parcours d'inscription en 7 étapes (code SMS), modèle unique, emails hors des adresses

| # | Étapes | Attendu |
|---|---|---|
| O1 | Rédaction réelle, classe virtuelle (aucun envoi) | étapes 1 à 7 dans l'ordre, pas d'étape 8 ; étape 3 = phrase SMS mot pour mot ; conseil sur le numéro de mobile ; numéro DPC à l'étape 5 |
| O2 | Rédaction réelle, e-learning (aucun envoi) | idem |
| O3 | Relance d'un mail dont le corps d'origine contient l'ancien parcours en 6 étapes : brouillon (`GET /api/relance`) et rédaction (`POST /api/relance/generate`) | les 7 étapes à jour + conseil ; aucune trace de l'ancien parcours (le mail d'origine n'est plus recopié) |
| O4 | `grep` des identifiants de modèle dans `app`, `lib`, `components` | uniquement `REDACTION_MODEL` dans `lib/config.ts` |
| O5 | `GET /api/contact-search` et `GET /api/contact-history` | 405 ; en POST, résultats normaux ; aucune adresse `/api/…` contenant un email pendant le parcours |
| O6 | Révocation : fiche `recubd9fXVX2rkhfB` → « Plus actif » puis « Actif » (connecteur Airtable), `/api/me` toutes les 2 s | 403 puis 200 dans le délai documenté (README, « Délai maximal de révocation ») ; aucune requête au-delà de 300 ms ; fiche relue « Actif » |

### N. Instantané (données Airtable jamais attendues)

| # | Étapes | Attendu |
|---|---|---|
| N1 | Supprimer `cache:airtable:*` (KV de test), démarrer `npm run start` | `instrumentation.ts` remplit fiches, formations, sessions et catalogue dans le KV en quelques secondes |
| N2 | Parcours complet à chaud (production locale) | étapes 2, 3, 4 et bascule Texte/Aperçu < 300 ms ; étape 5 ouverte ~0,3 s ; `/api/suivi`, `/api/contact-history`, préparation de relance < 300 ms ; recherche HubSpot 300 à 600 ms (service externe) |
| N3 | Formations proposées depuis le cache (Panorama de la vaccination, Refus scolaire anxieux ; médecin généraliste) | mêmes 3 formations et mêmes dates que l'ancien calcul Airtable ; calcul en quelques millisecondes |
| N4 | Contact choisi à l'étape 4 | `cache:deja_faites:{empreinte}` créé (10 min) ; la rédaction n'interroge plus Clients / Inscriptions |
| N5 | Aucune mention de l'IA | aucune occurrence de « Claude », « IA », « intelligence artificielle » dans l'interface, les messages d'erreur, les champs de l'API (`redigee`), les DM, les Notes et les mails |

### G. Non-régression complète

Connexion Google → génération → envoi → `opened` → `clicked` → `/suivi` (statut « Cliqué », dates) → déconnexion.
Étape 6 : libellé « Note ajoutée sur la fiche du PS ».

---

## 5. Nettoyage

```bash
node --no-warnings scripts/seed-test.ts clean     # supprime test-seed-*, test-legacy*, webhook_event:msg_seedtest_*, membres d'index de test
```

Puis, pour les envois réels faits pendant les tests :

1. **KV de test** : revérifier l'hôte, puis remettre la base dans son état de début de session avec l'export de référence (§3) :
   ```bash
   node --no-warnings scripts/migrate-kv.ts --host=$TEST_KV_HOST --restore=backups/<export-de-référence>.json            # liste ce qui sera supprimé
   node --no-warnings scripts/migrate-kv.ts --host=$TEST_KV_HOST --restore=backups/<export-de-référence>.json --confirm
   ```
   Cela retire aussi les compteurs `stats:day:*`, `meta:*` et index alimentés par les tests. Ne jamais supprimer la base elle-même.
   Supprimer ensuite les exports de `backups/` (données personnelles).
2. **HubSpot** : supprimer uniquement les Notes du contact de test créées pendant la session (vérifier l'association au contact avant chaque suppression).
3. **Gmail** : mettre à la corbeille uniquement les mails dont le sujet commence par `[TEST-` (vérifier le sujet ligne par ligne, ne rien ouvrir d'autre).
4. **Slack** : le testeur supprime lui-même les DM de relance.
5. Vérifier que le SHA-256 de `.env.local` est identique à celui du début.

---

## 6. Annexe — tester le rôle « commercial »

La session `dethie@medere.fr` est administrateur. Pour tester le rôle « commercial » (étape 1 verrouillée, refus d'agir au nom d'un autre), vider **temporairement** `ADMIN_EMAILS` dans `lib/config.ts` (`npm run dev` recharge à chaud), puis le remettre et vérifier `git diff lib/config.ts`. Pour un envoi au nom d'un autre commercial, utiliser un PS **sans adresse** : si le contrôle d'identité laissait passer, la requête s'arrêterait sur l'adresse manquante (400) sans rien envoyer.
