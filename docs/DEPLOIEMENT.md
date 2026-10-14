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
**Attendu** : la liste des envois dont le PS est le PS de test (contact `TEST_HUBSPOT_CONTACT_ID` ou adresse `TEST_PS_EMAIL`), au nom de différents commerciaux, et « N envoi(s) vers d'autres PS (conservés) ». **Vérifie qu'il n'y a que des essais.** Puis :
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

À faire juste après l'étape 6 (ou 7), avec ton profil administrateur et ton contact de test :

| # | Action | Résultat attendu |
|---|---|---|
| 1 | Se connecter avec ton compte Google | l'assistant s'affiche, ton nom présélectionné |
| 2 | Étapes 1 à 5 : une formation, ton contact de test (`TEST_PS_EMAIL`) | « déjà contacté » s'il y a eu un envoi récent ; à l'étape 5, le texte s'écrit au fil de l'eau, 7 étapes avec le code SMS |
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

---

## 7. Chantier « fix/admin-et-dates » (octobre 2026)

Ce que change ce chantier :
- **Administrateur indépendant d'Airtable** : son profil (email, nom, owner HubSpot, Slack, téléphone) est lu dans les variables `ADMIN_*` de Vercel. Il garde l'accès complet même si sa fiche Commerciaux est « Plus actif » ou supprimée, envoie en son nom (« Prénom Nom (moi) » à l'étape 1) ou au nom d'un commercial actif (tracé). Les alertes techniques partent vers `ADMIN_SLACK_USER_ID`.
- **Fiche « Plus actif »** : inchangé, la personne reste bloquée partout (sauf l'administrateur).
- **Jours de la semaine** : les dates des sessions sont calculées dans le code (Europe/Paris) et recopiées telles quelles par Claude ; contrôle automatique après rédaction (avertissement à l'étape 5 et dans la fenêtre de relance).
- **Notes HubSpot en double** : `dedupe-hubspot-notes.ts` sauvegarde chaque Note avant de l'archiver et sait la restaurer (`--restore`).

### 7.1 Migration de données : aucune
- Aucune clé KV à transformer, aucun script à lancer, rien à modifier dans Airtable.
- Les anciens envois et leur suivi sont lus tels quels.
- Les brouillons de relance déjà rédigés par Claude (format `v: 2`) sont ignorés et rédigés de nouveau à la prochaine ouverture de la fenêtre de relance (un appel à Claude par mail concerné), pour que leurs dates suivent les nouveaux libellés.

### 7.2 Avant la mise en ligne : variables Vercel
Vercel → projet → **Settings → Environment Variables**, environnement **Production** (et **Preview** si tu testes sur une préversion) :

| Variable | Valeur |
|---|---|
| `ADMIN_EMAIL` | ton email Google @medere.fr |
| `ADMIN_NAME` | ton nom tel qu'il doit apparaître en signature |
| `ADMIN_HUBSPOT_OWNER_ID` | ton owner HubSpot |
| `ADMIN_SLACK_USER_ID` | ton identifiant Slack (DM de relance de tes envois et alertes techniques) |
| `ADMIN_PHONE` | facultatif : téléphone de ta signature |

Les valeurs sont celles du bloc « Profil administrateur » de ton `.env.local`.
**À créer avant le déploiement** : sans elles, le rôle administrateur est désactivé (journal `[CONFIG] Rôle administrateur désactivé`), ton accès reste bloqué par ta fiche « Plus actif » et les alertes techniques ne partent plus.
**Ne jamais créer sur Vercel** : `DEV_FORCE_ROLE` (ignorée en production, avec une erreur dans les journaux) ni les `TEST_*` (scripts locaux).

### 7.3 Mise en ligne
1. Fusionner la branche dans `main` (Vercel déploie automatiquement), puis attendre « Ready ».
2. Vercel → **Logs** : aucune ligne `[CONFIG] Rôle administrateur désactivé` ni `[IDENTITE] DEV_FORCE_ROLE présent hors développement local`.

### 7.4 Tests de fumée (ton contact de test uniquement)
| # | Action | Attendu |
|---|---|---|
| 1 | Ouvrir l'app | Étape 1 : « Prénom Nom (moi) » présélectionné, puis les commerciaux actifs |
| 2 | Formation « L'IA en santé pour les médecins (Classe virtuelle) », une session, ton contact de test, « Générer le mail » | Ligne de session du type « Session 26.0xx : mardi … et jeudi … 2026, en soirée à partir de 19h00 », jours exacts ; aucun avertissement « dates incohérentes » |
| 3 | Dans le texte, remplacer un jour par un faux (« lundi » au lieu de « mardi ») | Avertissement « Une date incohérente … est un mardi, pas un lundi » ; il disparaît après correction. Ne pas envoyer ce texte |
| 4 | Envoyer un mail `[TEST-…]` à ton contact de test, en ton nom | Étape 6 OK ; `/suivi` : envoyé par toi, sans « par … » ; Note HubSpot sur ton contact |
| 5 | `/suivi` → « Relancer » sur ce mail → « Rédiger la relance » | Relance au nom de ton profil, sessions avec les mêmes libellés, aucun avertissement de dates |

Ensuite, archiver les Notes `[TEST-…]` créées sur ton contact de test.

### 7.5 Notes HubSpot en double (si l'étape 8 n'a pas encore été faite)
```powershell
node scripts/dedupe-hubspot-notes.ts --host=$H                 # rapport, aucune modification
node scripts/dedupe-hubspot-notes.ts --host=$H --apply         # sauvegarde backups\notes-archivees-<hôte>-<date>.json, puis archivage
# En cas de besoin : recréer les Notes archivées (contenu, date affichée, contact d'origine)
node scripts/dedupe-hubspot-notes.ts --restore=backups\notes-archivees-<hôte>-<date>.json
```
Garder le fichier de sauvegarde hors du dépôt (données personnelles) tant qu'une restauration peut être utile, puis le supprimer.

### 7.6 Retour arrière
Vercel → **Deployments** → déploiement précédent → **Instant Rollback**. Aucune donnée à restaurer. Les variables `ADMIN_*` peuvent rester (l'ancien code les ignore) ; avec l'ancien code, ton accès redevient bloqué tant que ta fiche est « Plus actif ».

---

## 8. Chantier « fix/relance-sessions » (octobre 2026)

La relance ne propose plus que des sessions encore ouvertes à l'inscription, avec la même règle que l'étape 3 de l'assistant. Cette règle unique change aussi l'étape 3 pour les classes virtuelles et présentiels (voir 8.2). Le DM Slack de J+3 signale les formations qui n'ont plus aucune session à venir.

### 8.1 Migration de données : aucune
- Aucune clé KV à transformer, aucun script à lancer, rien à modifier dans Airtable.
- Les nouveaux envois enregistrent leurs sessions (`session_ids`, `session_numeros` dans `email_track`). Pour les mails envoyés **avant** la mise en ligne, la relance retrouve les sessions dans le texte du mail relu chez Resend (numéros de session de la formation). Si Resend ne le fournit plus, la relance propose les 3 prochaines sessions ouvertes avec le message « Les sessions du premier mail n'ont pas pu être retrouvées… ».
- Brouillons de relance déjà rédigés : conservés. Celui dont les sessions ne sont plus celles du jour est ignoré et rédigé de nouveau à la prochaine demande (un appel à Claude par mail concerné). Les autres sont réutilisés tels quels.

### 8.2 Changement visible à l'étape 3 (à vérifier avant la mise en ligne)
Règle d'ouverture (`sessionOuverte`, `lib/session-label.ts`), seule nouveauté pour les **classes virtuelles et présentiels** : la session n'est proposée que si la plus ancienne des dates « Date de début de session » et « Date 1ère soirée CV / Date Présentiel » est **après** aujourd'hui (Paris). Une session qui commence aujourd'hui, ou sans aucune de ces dates, n'est plus proposée. **E-learning et autres formats (« Hybride ») : aucun changement.** `webflow_id` et rattachement à la formation : inchangés.

Comparaison faite le 13 octobre 2026 sur les données Airtable du jour (code de `main` contre nouveau code) : 214 sessions visibles avant, 212 après. Seules disparaissent les deux classes virtuelles qui commencent ce jour-là : « Les bruxismes… (Classe virtuelle) » 26.008 et « L'IA en santé pour les médecins (Classe virtuelle) » 26.010. Aucune session n'apparaît, aucun e-learning ne disparaît.

### 8.3 Variables Vercel
Aucune nouvelle variable. **Ne jamais créer `DEV_TODAY` sur Vercel** (simulation de la date du jour, développement local uniquement). Elle y serait ignorée, avec une erreur dans les journaux.

### 8.4 Mise en ligne
1. Fusionner la branche dans `main` (Vercel déploie automatiquement), puis attendre « Ready ».
2. Vercel → **Logs** : aucune ligne `[CONFIG] DEV_TODAY présent hors développement local`.
3. Au prochain passage du cron (8h UTC) : les DM de J+3 d'une formation sans session à venir contiennent la ligne « Plus aucune session à venir pour cette formation : propose une autre formation par téléphone. ».

### 8.5 Tests de fumée (ton contact de test uniquement)
| # | Action | Attendu |
|---|---|---|
| 1 | Étape 3, « L'IA en santé pour les médecins (Classe virtuelle) » ; puis une formation e-learning | Classe virtuelle : aucune session qui commence aujourd'hui ou avant. E-learning : mêmes sessions qu'avant la mise en ligne (sessions en cours comprises) |
| 2 | Envoyer un mail `[TEST-…]` à ton contact de test avec une ou deux sessions | `/suivi` : envoi présent (les sessions sont enregistrées dans le suivi) |
| 3 | `/suivi` → « Relancer » sur ce mail | Uniquement les sessions du mail d'origine ; aucun message au-dessus de l'objet |
| 4 | Dans le texte, ajouter la ligne « Session 26.010 : mardi 13 et jeudi 15 octobre 2026 » (session passée) | Avertissement « cette date est déjà passée » ; « Envoyer la relance » refusé : « La session 26.010 n'est plus ouverte à l'inscription… ». Retirer la ligne |
| 5 | Envoyer la relance `[TEST-…]` | Envoyée dans le fil du mail d'origine |
| 6 | `/suivi` → un ancien mail d'une formation sans session à venir (s'il en existe) | « Relancer » désactivé : « Aucune session à venir pour cette formation : relance impossible pour le moment. » |

Ensuite, archiver les Notes `[TEST-…]` créées sur ton contact de test.

### 8.6 Retour arrière
Vercel → **Deployments** → déploiement précédent → **Instant Rollback**. Aucune donnée à restaurer. Les champs `session_ids` et `session_numeros` des envois et `sessions` des brouillons sont ignorés par l'ancien code.
