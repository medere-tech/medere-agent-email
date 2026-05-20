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
8. [Relances automatiques J+3](#relances-automatiques-j3)
9. [Suivi des envois](#suivi-des-envois)
10. [Webhooks Resend](#webhooks-resend)
11. [HubSpot — Logging des emails](#hubspot--logging-des-emails)
12. [Déploiement](#déploiement)
13. [Maintenance](#maintenance)
14. [Résolution de problèmes fréquents](#résolution-de-problèmes-fréquents)

---

## Présentation

L'Agent Mail DPC permet aux commerciaux Médéré de générer et envoyer un mail personnalisé à un professionnel de santé (PS) en moins de 60 secondes.

**Workflow commercial :**
1. Le PS appelle → le commercial identifie la formation et la session
2. Le commercial ouvre l'app, sélectionne son nom, la formation, les sessions, et le contact HubSpot du PS
3. Claude (IA) génère un mail personnalisé
4. Le commercial valide et envoie
5. Le mail est loggué sur HubSpot (Note sur la fiche contact)
6. Une relance automatique est envoyée au commercial par DM Slack J+3 si le PS ne s'est pas inscrit

---

## Stack technique

| Outil | Usage |
|-------|-------|
| Next.js 14 (App Router) | Framework principal |
| TypeScript | Langage |
| Tailwind CSS | Styles |
| Vercel | Hébergement + Cron Jobs |
| Airtable | Base de données formations, sessions, commerciaux |
| HubSpot | CRM — recherche contacts PS + logging emails |
| Resend | Envoi des emails |
| Upstash KV (Redis) | Stockage relances J+3 + tracking emails |
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
│       │   ├── callback/google/route.ts  # Callback OAuth Google
│       │   └── logout/route.ts           # Déconnexion
│       ├── commerciaux/route.ts          # Liste des commerciaux actifs
│       ├── formations/route.ts           # Liste des formations actives
│       ├── sessions/route.ts             # Sessions par formation
│       ├── contact-search/route.ts       # Recherche contacts HubSpot
│       ├── generate/route.ts             # Génération mail via Claude
│       ├── send/route.ts                 # Envoi mail via Resend
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
│   └── hubspot.ts                        # Logging HubSpot
├── middleware.ts                          # Protection des routes + CVE-2025-29927
├── vercel.json                           # Configuration cron Vercel
└── .env.local                            # Variables d'environnement (local)
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
| `RESEND_FROM_DOMAIN` | Domaine d'envoi | `medere.fr` |
| `RESEND_WEBHOOK_SECRET` | Secret webhook Resend | resend.com → Webhooks |
| `SLACK_BOT_TOKEN` | Token bot Slack | api.slack.com → OAuth & Permissions |
| `KV_REST_API_URL` | URL Upstash KV | Vercel → Storage → KV |
| `KV_REST_API_TOKEN` | Token Upstash KV | Vercel → Storage → KV |
| `CRON_SECRET` | Secret sécurisation cron | Générer aléatoirement |
| `GOOGLE_CLIENT_ID` | Client ID Google OAuth | Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Secret Google OAuth | Google Cloud Console |
| `NEXTAUTH_SECRET` | Secret signature JWT sessions | Générer avec `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NEXTAUTH_URL` | URL de l'app | `https://medere-agent-email-dpc.vercel.app` (prod) ou `http://localhost:3000` (local) |

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
Sélection de la formation. Deux options dans `lib/airtable.ts` (voir section Airtable) :
- **Option B (active)** : formations avec `{Statut}="Active"` ET numéro DPC renseigné
- **Option A (commentée)** : idem + au moins une session future avec `webflow_id`

**Étape 3 — Sessions**
Sessions filtrées par :
- Liée à la formation sélectionnée
- `webflow_id` présent (évite les doublons)
- Date future — **sauf pour l'e-learning** : les sessions en cours (commencées mais pas terminées) sont incluses

**Étape 4 — Contact PS**
Recherche dans HubSpot par nom, prénom ou email. Sélection du titre de politesse (Docteur / Madame / Monsieur).

**Étape 5 — Aperçu**
Mail généré par Claude, modifiable avant envoi.

**Étape 6 — Confirmation**
Statuts : mail envoyé ✓, note HubSpot ✓, relance J+3 ✓.

---

## Authentification

### Technologie
Google OAuth 2.0 natif — aucune librairie d'auth. JWT signé avec `jose`.

### Flux
1. Utilisateur non connecté → redirigé vers `/login`
2. Clic "Se connecter avec Google" → Google OAuth
3. Vérification côté serveur que l'email est `@medere.fr`
4. Cookie de session JWT créé (httpOnly, secure, 24h)
5. Middleware vérifie le cookie sur chaque requête

### Durée de session
24 heures. Modifiable dans `lib/auth.ts` :
```typescript
const SESSION_DURATION = 60 * 60 * 24 // 24 heures
```

### Sécurité
- Cookie `httpOnly` — inaccessible via JavaScript
- Cookie `secure` en production — HTTPS uniquement
- Vérification `@medere.fr` côté serveur (pas seulement côté Google)
- Protection CVE-2025-29927 dans `middleware.ts`
- JWT signé — impossible à falsifier sans `NEXTAUTH_SECRET`

### Couper l'accès à un commercial
Désactiver son compte Google Workspace `@medere.fr` — il ne pourra plus se connecter à la prochaine expiration de session (max 24h).

### Google Cloud Console
- Projet : `medere-agent-email`
- Type d'utilisateur : **Interne** (seuls les comptes @medere.fr autorisés)
- Redirect URI prod : `https://medere-agent-email-dpc.vercel.app/api/auth/callback/google`
- Redirect URI local : `http://localhost:3000/api/auth/callback/google`

---

## Airtable — Formations et Sessions

### Filtres formations (`getFormationsActives`)

Deux options dans `lib/airtable.ts` — une seule active à la fois :

**Option B (recommandée par Maylis — actuellement active)**
```
{Statut de la formation}="Active" AND {Numéro d'action DPC}!=""
```
Toutes les formations actives avec numéro DPC apparaissent, qu'elles aient des sessions ou non.

**Option A (avec filtre sessions futures — commentée)**
Idem Option B + formations ayant au moins une session future avec `webflow_id`. À activer si on veut masquer les formations sans sessions disponibles.

Pour basculer : commenter/décommenter les blocs dans `getFormationsActives` dans `lib/airtable.ts`.

### Filtres sessions (`getSessionsByFormation`)

- Liée à la formation via `Numéro d'action DPC`
- `webflow_id` présent (évite les sessions en doublon)
- Date future **sauf e-learning** : les sessions dont la date de début est passée mais la date de fin est future sont incluses
- Pagination complète (toutes les pages Airtable chargées)

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
| `Numéro d'action DPC` | Lien avec la formation |
| `webflow_id` | Filtre anti-doublon |
| `Format` | Détection e-learning |

---

## Relances automatiques J+3

### Fonctionnement
À chaque envoi de mail, une clé est stockée dans Upstash KV :
```
relance:{timestamp} → { commercial_slack_id, ps_nom, ps_email, formation_nom, relance_at, ... }
```

Le cron Vercel tourne tous les jours à 8h UTC (`0 8 * * *`). Il scanne toutes les clés `relance:*` et envoie un DM Slack au commercial si `relance_at === today`.

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

### Vérifier le cron
Vercel → projet → **Cron Jobs** dans le menu gauche → voir le dernier statut d'exécution.

### Logs à surveiller
```
[CRON] Date today: YYYY-MM-DD
[CRON] Clés trouvées: N
[CRON] Item: relance:XXX → relance_at: YYYY-MM-DD | match: true/false
```

---

## Suivi des envois

Page accessible à `/suivi` — réservée aux utilisateurs connectés.

### Fonctionnement
À chaque envoi, deux clés KV sont créées :
- `email_track:{resendId}` → données complètes de l'envoi (sans expiry — stockage permanent)
- Entrée dans `emails_index` (sorted set Upstash) → pour la pagination

### Stats
Calculées sur la **totalité** des emails dans l'index — pas un sous-ensemble.

### Colonnes affichées
PS (nom + email) · Commercial · Formation · Statut · Envoyé · Lien HubSpot

### Statuts
- **Envoyé** : mail transmis via Resend
- **Ouvert** : PS a ouvert le mail (via webhook Resend)
- **Cliqué** : PS a cliqué un lien dans le mail (via webhook Resend)

---

## Webhooks Resend

### Configuration
Dans resend.com → Webhooks → endpoint :
```
https://medere-agent-email-dpc.vercel.app/api/webhooks/resend
```

Événements activés : `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`

### Fonctionnement
Quand le PS ouvre ou clique le mail :
1. Resend envoie un webhook signé (vérification Svix)
2. L'app retrouve l'entrée KV via l'email ID
3. Une Note est créée sur la fiche HubSpot du contact
4. Le statut KV est mis à jour (`ouvert` ou `cliqué`)

---

## HubSpot — Logging des emails

Les emails envoyés sont loggués comme **Notes** sur la fiche HubSpot du contact PS.

Format de la note :
```
📧 Email envoyé à {email}
Sujet : {sujet}
---
{corps du mail}
```

La note est associée au contact via `associationTypeId: 202`.

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
cp .env.local.example .env.local  # remplir les variables
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

### Basculer Option A / Option B des formations
Dans `lib/airtable.ts`, fonction `getFormationsActives` :
- **Option B active** (actuel) : commenter le bloc Option A, décommenter le bloc Option B
- **Option A active** : commenter le bloc Option B, décommenter le bloc Option A

### Modifier la durée de session
Dans `lib/auth.ts` :
```typescript
const SESSION_DURATION = 60 * 60 * 24 // modifier cette valeur
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
- Si Option A active : la formation a-t-elle des sessions futures avec `webflow_id` ?

### Une session n'apparaît pas
**Vérifier dans Airtable :**
- `webflow_id` renseigné ?
- Date de début dans le futur ? (sauf e-learning)
- Pour e-learning : date de fin pas encore dépassée ?
- Liée à la bonne formation via `Numéro d'action DPC` ?

### Les relances Slack ne partent pas
1. Vercel → Cron Jobs → vérifier que le cron tourne
2. Logs Vercel → chercher `[CRON]` → voir `match: true/false`
3. Vérifier `SLACK_BOT_TOKEN` et `CRON_SECRET` dans les env vars Vercel
4. Vérifier que le bot Slack a les scopes `chat:write` et `im:write`
5. Vérifier que `slack_user_id` est renseigné pour le commercial dans Airtable

### Le webhook Resend ne met pas à jour le statut
1. resend.com → Webhooks → vérifier que l'URL est correcte
2. Vérifier `RESEND_WEBHOOK_SECRET` dans les env vars Vercel
3. Logs Vercel → chercher `[WEBHOOK]`

### Erreur 500 sur /api/sessions
Vérifier que le champ `Format` est bien dans les fields chargés dans `getSessionsByFormation`.

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