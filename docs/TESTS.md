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
| Node | ≥ 22.18 (exécute `scripts/seed-test.ts` sans dépendance) |
| Navigateur | session Google @medere.fr ouverte sur `http://localhost:3000` |

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
3. **Commercial de test** : s'il n'existe pas dans Airtable, ne pas utiliser un vrai commercial (la copie et le DM partiraient chez lui). Injecter le commercial de test dans les requêtes `/api/generate` et `/api/send` depuis la console du navigateur (snippet §6), avec garde-fou sur le PS.
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
| E3 | Passer l'étape 1, fausser `AIRTABLE_TOKEN`, cliquer « Continuer » | bandeau « Impossible de charger les formations » |
| E4 | Formations chargées, fausser `AIRTABLE_TOKEN`, choisir une formation | bandeau « Impossible de charger les sessions » — **restaurer** |
| E5 | Requête `/api/generate` sans cookie (`credentials: 'omit'`) | « Session expirée, reconnecte-toi. » |

### F. Pagination, session, déconnexion, secrets, formations

| # | Étapes | Attendu |
|---|---|---|
| F1 | Charger `/api/formations` et `/api/sessions` 4 fois à < 60 s d'intervalle | toujours 200, mêmes nombres, aucun 422 `LIST_RECORDS_ITERATOR_NOT_AVAILABLE` |
| F2 | Se reconnecter, inspecter le cookie `medere_session` (DevTools → Application) | expiration ≈ connexion + 7 jours (même durée pour le JWT). Rappel : la session n'est pas révocable — un compte Google désactivé garde l'accès jusqu'à 7 jours ; seule la rotation de `NEXTAUTH_SECRET` coupe toutes les sessions |
| F3 | « Se déconnecter » sur `/` puis sur `/suivi` | `POST /api/auth/logout` → 303 → `/login` ; `/` redirige vers `/login` ; `GET /api/auth/logout` → 405 ; ancienne route `/api/auth/callback/google/logout` → 404 |
| F4 | Retirer `NEXTAUTH_SECRET`, **redémarrer** `npm run dev` | `/` et `/api/*` → 500 + log `[AUTH] NEXTAUTH_SECRET manquant` ; `/login` reste en 200 ; callback → 500 — **restaurer et redémarrer** |
| F5 | `/api/formations` avec `FORMATIONS_REQUIRE_FUTURE_SESSION = false` | même nombre qu'un comptage Airtable `Active` + numéro DPC |
| F6 | (optionnel) passer la constante à `true` | uniquement les formations avec session future ; **remettre `false`** |

### H. Fondations des données (schéma v2)

Webhooks : `seed-test.ts webhook <delivered|bounced|complained|opened|clicked> <id> [--created-at=<iso>] [--message-id=<id>]`.
Compteurs : `HGETALL stats:day:<jour d'envoi>` ; entrée : `GET email_track:<id>`.

| # | Étapes | Attendu |
|---|---|---|
| H1 | Envoi réel `[TEST-H]` | `email_track` avec `v: 2`, `sent_day`, `commercial_key` ; `email_body` (TTL ≈ 90 j) ; membre dans `emails_index`, `idx:commercial:<email>`, `idx:contact:<id>`, `relances_due` (score = J+3 00:00 UTC) ; `stats:day` : `sent` +1 et `sent\|<email>` +1 ; plus aucune clé `relance:*` créée |
| H2 | `delivered --message-id=<x>` sur H1 | statut `délivré`, `delivered_at`, `message_id` ; `delivered` +1 |
| H3 | `opened --created-at=<livraison + 10 s>` | `auto_open_count: 1`, `first_auto_opened_at` ; statut, `open_count` et compteurs inchangés ; aucune Note |
| H4 | `opened` (maintenant, > 60 s) puis 2 × `opened` | statut `ouvert`, `first_opened_at` figé, `last_opened_at` mis à jour, `open_count: 3` ; `opened` +1 une seule fois ; 1 seule Note « ouvert » |
| H5 | `clicked --created-at=<livraison + 5 s>` puis `clicked` | 1er clic automatique (aucune Note, aucun compteur) ; 2e : statut `cliqué`, `clicked` +1, 1 Note « cliqué » |
| H6 | `bounced` sur un autre envoi déjà ouvert | statut `bounce` (prioritaire), `bounced` +1 ; puis `opened` → statut reste `bounce` |
| H7 | `complained` | statut `plainte`, `complained` +1 |
| H8 | Webhooks sur `test-legacy` **avant** migration | entrée mise à jour, verrou `legacy`, aucune Note « ouvert », **aucun** compteur modifié |
| H9 | `/suivi` avant migration | toutes les entrées lisibles, stats calculées sur les entrées ; badges Délivré / Bounce / Plainte |
| H10 | `migrate-kv.ts --dry-run` (après `seed --relance --names`) | rapport : compteurs par jour, commerciaux, « À VALIDER » (`Commercial de test`, `Loane Deluge`), relances rattachées / legacy ; **DBSIZE inchangé** |
| H11 | `--host` faux ; migration sans export de moins d'une heure (`--backup-dir` vide) | les deux refusées (exit 1) |
| H12 | `--export` puis migration réelle | entrées en `v: 2`, compteurs et index créés, `relance:test-seed-today` rattachée et supprimée, `legacy:relance:test-seed-orphan` dans `relances_due`, `meta:schema_version = 2` |
| H13 | Relancer la migration ; comparer deux exports avant / après | « 0 envoi(s) migré(s) », aucune différence de valeur (hash comparés sans ordre) |
| H14 | `--restore=<export H12>` sans puis avec `--confirm` | plan sans écriture ; puis base identique à l'export (clés, valeurs, TTL) |
| H15 | Webhooks sur `test-legacy` **après** migration | aucune nouvelle Note « ouvert », compteurs non doublés |
| H16 | `/suivi` après migration | stats = somme des `stats:day:*` ; mêmes chiffres qu'avant migration |
| H17 | Purge : entrée de test datée de 1 100 jours (score de `emails_index` + entrées d'index), puis appel du cron | `purged: 1`, `email_track`, `email_body`, verrous et membres d'index supprimés ; les autres envois intacts |

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

## 6. Annexe — injection du commercial de test (console du navigateur)

À coller sur `http://localhost:3000` avant de dérouler l'assistant (perdu au rechargement de la page) :

```js
(() => {
  const TC = { name: 'Dethie Faye', email: 'dethie@medere.fr', hubspot_id: '<owner-id-hubspot>', slack_user_id: '<slack-id>' }
  const PS_ID = '18421683158', PS_EMAIL = 'dethie@medere.fr'
  const orig = window.__origFetch || window.fetch
  window.__origFetch = orig
  window.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.startsWith('/api/send') || u.startsWith('/api/generate')) {
      const b = JSON.parse(init.body)
      if (b.ps?.email !== PS_EMAIL || (u.startsWith('/api/send') && b.ps?.id !== PS_ID)) throw new Error('GARDE-FOU : PS non autorisé')
      b.commercial = u.startsWith('/api/send') ? { ...TC } : { name: TC.name, email: TC.email, phone: '' }
      init = { ...init, body: JSON.stringify(b) }
    }
    return orig(url, init)
  }
})()
```
