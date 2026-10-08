# Déploiement en production — guide pas à pas

Ce guide décrit la mise en production de la branche `feat/evolutions-commerciaux` (lots 1 à 5) : passage des données au nouveau format, mise en ligne, vérifications, retour arrière. Il a été répété en entier sur la base de test le 8 octobre 2026 (données au format de la production actuelle, ancien code qui continue d'écrire pendant la mise en ligne) : chiffres de `/suivi` identiques avant et après, contrôle `--verify` à 0 écart.

Toutes les commandes se tapent dans **PowerShell**, dans le dossier du projet (`Documents\GitHub\medere-agent-email`). Lis le résultat de chaque commande avant de passer à la suivante : chaque script commence par un **rapport sans rien modifier**.

Durée totale : environ 45 minutes, dont 15 de vérifications.

---

## 1. Prérequis (la veille ou le jour même, avant de commencer)

### 1.1 Resend : ajouter trois événements au webhook
Resend → **Webhooks** → l'endpoint `https://medere-agent-email-dpc.vercel.app/api/webhooks/resend` → **Edit** → cocher, en plus de `email.opened` et `email.clicked` :
- `email.delivered`
- `email.bounced`
- `email.complained`

Enregistrer. (L'ancien code ignore ces événements sans erreur : on peut le faire dès maintenant.)

### 1.2 Vercel : variables d'environnement
Vercel → projet **medere-agent-email** → **Settings → Environment Variables** (environnement **Production**). Elles doivent toutes exister :

| Variable | Rôle | À vérifier |
|---|---|---|
| `NEXTAUTH_URL` | adresse de l'app | **exactement** `https://medere-agent-email-dpc.vercel.app` (les liens des DM Slack l'utilisent) |
| `NEXTAUTH_SECRET` | signature des sessions | présente (ne pas la changer : tout le monde serait déconnecté) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | connexion Google | présentes |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | base Upstash de **production** | présentes |
| `AIRTABLE_BASE_ID`, `AIRTABLE_TOKEN` | formations, sessions, fiches commerciales | présentes (le jeton peut rester en lecture seule) |
| `HUBSPOT_TOKEN` | recherche de contacts, Notes | présente |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | envoi, webhook | présentes |
| `RESEND_FROM_DOMAIN` | domaine d'envoi | facultative (par défaut `medere.fr`) |
| `ANTHROPIC_API_KEY` | rédaction | présente |
| `SLACK_BOT_TOKEN` | DM de relance, de premier clic, alertes | présente |
| `CRON_SECRET` | protège le passage quotidien | **obligatoire** : sans elle, le cron répond en erreur |

À **supprimer** si elle existe : `HS_WRITE_SCOPE_ENABLED` (plus lue par aucun code).

### 1.3 Airtable : identifiants Slack manquants
Table **Commerciaux**, fiches **Actif** sans `slack_user_id` (relevé du 8 octobre 2026) : **Éric Attlane**, **Steave Bimai**. Sans cet identifiant, ils ne reçoivent ni les relances J+3 ni le DM de premier clic (une alerte te le signale chaque matin). Le compléter dans Airtable (Slack → leur profil → ⋮ → *Copier l'identifiant du membre*).

### 1.4 Ton poste
- Node.js 22.18 ou plus récent : `node --version` doit afficher `v22.18` ou plus.
- Le projet à jour sur la branche `feat/evolutions-commerciaux` (tous les lots commités).
- Un fichier **`.env.prod-kv.local`** à la racine du projet (ignoré par git, jamais lu par l'app en local), avec les valeurs de **production** copiées depuis Vercel :
  ```
  KV_REST_API_URL=https://xxxx.upstash.io
  KV_REST_API_TOKEN=...
  AIRTABLE_BASE_ID=...
  AIRTABLE_TOKEN=...
  HUBSPOT_TOKEN=...
  ```
- L'hôte de la base de production : la partie de `KV_REST_API_URL` après `https://` (ex. `xxxx.upstash.io`).

Dans **chaque nouvelle fenêtre PowerShell** utilisée pour ce guide, commence par :
```powershell
$env:ENV_FILE = ".env.prod-kv.local"
$H = "xxxx.upstash.io"     # remplace par l'hôte de production
```
Les scripts refusent de tourner si `$H` ne correspond pas à l'adresse du fichier : aucun risque de viser la mauvaise base.

---

## 2. Moment conseillé

**Un soir de semaine après 19 h 30** (fin des appels), ou avant 9 h. Éviter :
- les heures d'appel des commerciaux (un mail envoyé pendant la bascule reste correct, mais autant n'en avoir aucun) ;
- **10 h 00 heure de Paris** (8 h UTC, 9 h en hiver) : passage quotidien du cron.

Prévenir l'équipe : « Mise à jour de l'Agent Mail ce soir de 19 h 30 à 20 h 30. Demain, rechargez la page (Ctrl + F5) avant d'envoyer. » (Une page `/suivi` restée ouverte depuis la veille affiche une erreur tant qu'elle n'est pas rechargée.)

---

## 3. Ordre exact

### Étape 1 — Sauvegarde complète de la base de production
```powershell
node scripts/migrate-kv.ts --host=$H --export
```
**Attendu** : `Fichier : ...\backups\kv-export-<hôte>-<date>.json`. Note le nom du fichier : c'est ton point de retour arrière. (L'export n'est valable qu'**une heure** pour les étapes 2 et 3 : si tu dépasses, relance-le.)

### Étape 2 — Suppression des envois de test
```powershell
node scripts/purge-test-sends.ts --host=$H            # rapport
```
**Attendu** : la liste des envois dont le PS est ta fiche de test (contact `18421683158` ou `dethie@medere.fr`), au nom de différents commerciaux, et « N envoi(s) vers d'autres PS (conservés) ». **Vérifie qu'il n'y a que des essais.** Puis :
```powershell
node scripts/purge-test-sends.ts --host=$H --apply
```
**Attendu** : `Suppression terminée : N envoi(s) ... M ancienne(s) relance(s).`

### Étape 3 — Migration des données
```powershell
node scripts/migrate-kv.ts --host=$H --dry-run        # rapport
```
**Attendu** :
- `Envois : X au total, 0 déjà en v2, X à migrer` ;
- la liste **Commerciaux** (nom → email) ;
- éventuellement **À VALIDER** : des noms d'anciens envois qui ne correspondent à aucune fiche, ou dont le prénom ne correspond pas à l'email de la fiche. Ils resteront regroupés sous `nom:…` dans le suivi ; c'est sans conséquence, mais si un nom te paraît anormal, arrête-toi et regarde la fiche Airtable ;
- **Anciennes relances** : rattachées à leur envoi (celles dont l'échéance est dépassée seront rattrapées par le cron) ou « non rattachées, planifiées en legacy ».

Puis :
```powershell
node scripts/migrate-kv.ts --host=$H
```
**Attendu** : `Migration terminée : X envoi(s) migré(s), 0 envoi(s) déjà migré(s) rattrapé(s), ... meta:schema_version = 2.`

### Étape 4 — Contrôle
```powershell
node scripts/migrate-kv.ts --host=$H --verify
```
**Attendu**, en dernière ligne : `OK : chaque fait est compté exactement une fois.` (`Écarts de compteurs : 0`, `Incohérences fait / comptage : 0`). **S'il y a un écart, arrête-toi** (voir « Retour arrière »).

### Étape 5 — Mise en ligne
1. GitHub → **Pull request** de `feat/evolutions-commerciaux` vers `main` → **Merge**.
2. Vercel déploie automatiquement. Vercel → **Deployments** : attendre l'état **Ready** du nouveau déploiement (2 à 3 minutes).
3. Ouvrir `https://medere-agent-email-dpc.vercel.app`, recharger (Ctrl + F5) : l'assistant s'affiche, l'étape 5 a les onglets « Texte » / « Aperçu ».

**Note le déploiement précédent** (celui qui était en ligne avant) : c'est celui de l'« Instant Rollback ».

### Étape 6 — Seconde migration (immédiatement après la mise en ligne)
Entre l'étape 1 et la mise en ligne, l'ancien code a pu envoyer des mails et recevoir des ouvertures ou des clics : la seconde migration les reprend.
```powershell
node scripts/migrate-kv.ts --host=$H --export
node scripts/migrate-kv.ts --host=$H --dry-run
node scripts/migrate-kv.ts --host=$H
node scripts/migrate-kv.ts --host=$H --verify
```
**Attendu** :
- dry-run : `Y à migrer` (nouveaux envois de l'ancien code, souvent 0) et éventuellement `Z déjà en v2 à rattraper (modifiés par l'ancien code ...)` ;
- migration : `Migration terminée : Y envoi(s) migré(s), Z envoi(s) déjà migré(s) rattrapé(s), ...` ;
- verify : `OK : chaque fait est compté exactement une fois.`

### Étape 7 — Date de fiabilité des ouvertures
Avant aujourd'hui, l'ancien code mettait le commercial en copie cachée : ses propres ouvertures étaient comptées. Dans `lib/config.ts`, remplace :
```ts
export const TRACKING_RELIABLE_SINCE: string | null = null
```
par la date du jour (format AAAA-MM-JJ), par exemple :
```ts
export const TRACKING_RELIABLE_SINCE: string | null = '2026-10-15'
```
Commit, push sur `main` (ou petite pull request), attendre **Ready** sur Vercel.
**Attendu** : dans `/suivi`, sur « 30 jours », la mention « Taux d'ouverture antérieurs au 15/10/2026 surestimés (copie commerciale comptée). » ; sur « Aujourd'hui », pas de mention.

### Étape 8 — Notes HubSpot en double
Avant, une Note « Email ouvert » était créée à chaque ouverture. D'abord le rapport :
```powershell
node scripts/dedupe-hubspot-notes.ts --host=$H
```
**Attendu** : par contact, le nombre de Notes de l'agent, de doublons à archiver et de **cas ambigus** (non traités). Relis le rapport (au besoin, ouvre 2 ou 3 fiches HubSpot citées pour vérifier qu'il s'agit bien de doublons). Puis :
```powershell
node scripts/dedupe-hubspot-notes.ts --host=$H --apply
```
**Attendu** : `N Note(s) archivée(s)`. Les Notes archivées restent dans la corbeille HubSpot 90 jours.

---

## 4. Tests de fumée en production (avec ta fiche uniquement)

À faire juste après l'étape 6 (ou 7), avec ta fiche « Dethie Faye » et ton contact de test :

| # | Action | Résultat attendu |
|---|---|---|
| 1 | Se connecter avec ton compte Google | l'assistant s'affiche, ton nom présélectionné |
| 2 | Étapes 1 à 5 : une formation, ton contact `dethie@medere.fr` | « déjà contacté » s'il y a eu un envoi récent ; à l'étape 5, le texte s'écrit au fil de l'eau, 7 étapes avec le code SMS |
| 3 | Objet préfixé `[TEST-PROD]`, « Envoyer le mail » | étape 6 : mail envoyé, Note HubSpot, relance programmée |
| 4 | `/suivi`, période « Aujourd'hui », « Mes envois » | le mail apparaît (Envoyé puis Reçu en quelques secondes) ; indicateurs non nuls sur « 30 jours » |
| 5 | Ouvrir le mail dans ta boîte, cliquer sur le lien agencedpc.fr | `/suivi` : Ouvert puis Cliqué (actualiser) ; DM Slack « vient de cliquer dans ton mail » |
| 6 | `/suivi` → détail du mail → « Relancer » | la fenêtre s'ouvre avec la relance pré-remplie (ne pas envoyer, ou envoyer à toi `[TEST-PROD]`) |
| 7 | Exporter (CSV) | le fichier s'ouvre dans Excel avec les bonnes colonnes |

Puis supprime ces envois de test du suivi :
```powershell
node scripts/migrate-kv.ts --host=$H --export
node scripts/purge-test-sends.ts --host=$H
node scripts/purge-test-sends.ts --host=$H --apply
node scripts/migrate-kv.ts --host=$H --verify
```

---

## 5. Retour arrière

### Le site ne marche pas après la mise en ligne
Vercel → **Deployments** → le déploiement précédent (noté à l'étape 5) → **⋯ → Instant Rollback** → confirmer. L'ancienne version est en ligne en quelques secondes.

L'ancien code lit sans problème les données migrées (il ne regarde que les champs qu'il connaît). Il n'y a donc **pas besoin** de restaurer la base, sauf si les données elles-mêmes posent problème. Deux conséquences à connaître tant que l'ancienne version reste en ligne :
- les relances J+3 des mails envoyés **avant** la migration ont été reprises au nouveau format : l'ancien cron ne les voit plus (pas de DM « Relance à faire » pour elles) ;
- quand tu remettras la nouvelle version en ligne, refais l'**étape 6** (export, migration, `--verify`) : elle reprend les mails envoyés et les ouvertures reçues entre-temps par l'ancienne version.

### Les données posent problème (écart à `--verify`, chiffres aberrants)
Restaurer la base dans l'état d'un export (le premier de la journée pour tout annuler) :
```powershell
node scripts/migrate-kv.ts --host=$H --restore=backups\kv-export-<hôte>-<date>.json            # plan, aucune écriture
node scripts/migrate-kv.ts --host=$H --restore=backups\kv-export-<hôte>-<date>.json --confirm  # restauration
```
**Attention** : tout ce qui a été écrit après cet export (mails envoyés, ouvertures) est perdu dans le suivi (les mails eux-mêmes sont bien partis, et les Notes HubSpot restent). Si le nouveau code est déjà en ligne, fais d'abord l'Instant Rollback, puis la restauration : le nouveau code sait aussi afficher une base non migrée (calcul de secours), mais l'ancien et la base d'origine forment le couple connu.

Après un retour arrière, préviens-moi avec le message d'erreur ou la sortie de la commande en cause.

---

## 6. À surveiller les jours suivants

- **Chaque matin vers 10 h 05** (8 h 05 UTC) : Vercel → **Cron Jobs** → `/api/cron/relance` → dernier passage en succès. Les commerciaux reçoivent leurs DM « Relance à faire » (le premier matin, les relances en retard sont rattrapées : un peu plus de DM que d'habitude).
- **Alertes Slack** (DM « Agent Mail — … » à toi) : erreurs du passage quotidien (par exemple un commercial sans `slack_user_id`), ou Note HubSpot en échec définitif. Une alerte = une action concrète décrite dans le message.
- **Journaux Vercel** (projet → **Logs**, filtrer sur *Error*) : rechercher `[WEBHOOK]`, `[CRON]`, `[HUBSPOT]`, `[RELANCE]`, `[GENERATE]`. Quelques `[AIRTABLE] Rafraîchissement en arrière-plan impossible` isolés sont sans conséquence (la dernière version connue est servie) ; s'ils se répètent, vérifier le jeton Airtable.
- **Resend → Webhooks → Deliveries** : les envois au webhook répondent 200. Des 401 indiqueraient un `RESEND_WEBHOOK_SECRET` différent de celui de Resend.
- **`/suivi`** : les taux d'ouverture des nouveaux envois sont plus bas qu'avant (la copie commerciale n'est plus comptée) : c'est attendu.
- **Une semaine après** : relancer `node scripts/migrate-kv.ts --host=$H --verify` (doit rester à 0 écart).
