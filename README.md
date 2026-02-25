# Agent Mail DPC — Médéré

Génère et envoie des mails DPC personnalisés en moins de 60 secondes.
Stack : Next.js 14 · Airtable · Claude API · HubSpot · Resend · Vercel KV

---

## Déploiement en 4 étapes

### 1. Pusher sur GitHub

```bash
git init && git add . && git commit -m "feat: agent mail DPC v1"
git remote add origin https://github.com/TON_ORG/medere-agent.git
git push -u origin main
```

### 2. Importer sur Vercel

- Aller sur https://vercel.com/new
- Importer le repo
- Framework : Next.js (auto-détecté)
- Configurer les env vars AVANT de déployer

### 3. Variables d'environnement Vercel

| Variable | Valeur |
|---|---|
| AIRTABLE_TOKEN | pat1j52UcIySHuj8h... |
| AIRTABLE_BASE_ID | app3GnMOzJn7VHMji |
| HUBSPOT_TOKEN | pat-eu1-788132ef... |
| ANTHROPIC_API_KEY | sk-ant-... |
| RESEND_API_KEY | re_... |
| RESEND_FROM_DOMAIN | medere.fr |
| SLACK_BOT_TOKEN | xoxb-... |
| CRON_SECRET | secret_32chars_random |
| HS_WRITE_SCOPE_ENABLED | false (true quand scope ajouté) |
| KV_REST_API_URL | auto (Vercel KV) |
| KV_REST_API_TOKEN | auto (Vercel KV) |

### 4. Vercel KV

Dashboard Vercel > Storage > Create > KV > Connect au projet.
Les env vars sont ajoutées automatiquement.

---

## HubSpot scope manquant

Le scope crm.objects.contacts.write est absent pour l'instant.
Impact : le mail est envoyé et la relance J+3 est stockée, mais il n'est pas loggé comme activité HubSpot.

Quand le scope est disponible :
1. L'ajouter dans la Private App HubSpot
2. Passer HS_WRITE_SCOPE_ENABLED à true dans Vercel
3. Redéployer

---

## Resend (envoi email)

1. https://resend.com > Domains > Add medere.fr
2. Ajouter les enregistrements DNS
3. Copier la clé API dans RESEND_API_KEY

---

## Slack Bot (relances J+3)

1. https://api.slack.com/apps > Create New App
2. Scopes : chat:write, im:write
3. Installer dans le workspace
4. Copier le Bot Token (xoxb-...) dans SLACK_BOT_TOKEN
