import { NextRequest, NextResponse } from 'next/server'
import { isPsInscritAFormation } from '@/lib/airtable'
import { getKv, kvConfigured } from '@/lib/kv'
import { purgeExpired } from '@/lib/tracking'
import { RETENTION_DAYS } from '@/lib/config'

export async function GET(req: NextRequest) {
  // Verify cron secret. Sans CRON_SECRET, la valeur attendue deviendrait
  // "Bearer undefined" : n'importe qui pourrait déclencher le cron.
  if (!process.env.CRON_SECRET) {
    console.error('[CRON] CRON_SECRET manquant — exécution refusée')
    return NextResponse.json({ error: 'Configuration serveur invalide (CRON_SECRET manquant)' }, { status: 500 })
  }
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date().toISOString().split('T')[0]
  let notified = 0
  let purged = 0
  let errors: string[] = []

  try {
    if (!kvConfigured()) {
      return NextResponse.json({ message: 'KV non configuré — relances désactivées' })
    }

    const kv = getKv()

    // Scan all relance keys
    const keys = await kv.keys('relance:*')

    for (const key of keys) {
      const item = await kv.get<any>(key)
      if (!item || item.relance_at !== today) continue

      // Send Slack DM to the commercial
      // Vérifier si le PS est déjà inscrit dans Airtable
      try {
        let dejaInscrit = false
        try {
          dejaInscrit = await isPsInscritAFormation(item.ps_rpps, item.ps_email, item.formation_numero)
        } catch (e: any) {
          // Airtable indisponible : on relance quand même (mieux vaut trop que pas assez),
          // mais l'erreur est tracée au lieu d'être avalée.
          console.error('[CRON] Vérification inscription impossible pour', key, ':', e.message)
          errors.push(`${key}: vérification inscription impossible (${e.message}) — relance envoyée quand même`)
        }
        if (dejaInscrit) {
          await kv.del(key) // Supprimer silencieusement — plus besoin de relancer
          continue
        }

        if (!item.commercial_slack_id) {
          errors.push(`${key}: slack_user_id manquant pour ${item.commercial_name}`)
          continue
        }

        const slackMsg = buildSlackMessage(item)
        await sendSlackDM(item.commercial_slack_id, slackMsg)
        await kv.del(key)
        notified++
      } catch (e: any) {
        errors.push(`${key}: ${e.message}`)
      }
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }

  // Rétention RGPD : purge des envois de plus de RETENTION_DAYS jours (indépendante des relances)
  try {
    purged = await purgeExpired()
    if (purged) console.log(`[CRON] Purge RGPD : ${purged} envoi(s) de plus de ${RETENTION_DAYS} jours supprimé(s)`)
  } catch (e: any) {
    console.error('[CRON] Purge RGPD en échec:', e.message)
    errors.push(`purge RGPD: ${e.message}`)
  }

  return NextResponse.json({ date: today, notified, purged, errors })
}

function buildSlackMessage(item: any): string {
  return `*📬 Relance à faire : ${item.ps_nom}*

Tu avais envoyé un mail le ${formatDate(item.sent_at)} à *${item.ps_nom}* pour la formation *"${item.formation_nom}"* (N° ${item.formation_numero}).

Il ne s'est pas encore inscrit. Voici un mail de relance prêt à envoyer :

---
*Sujet :* Re: ${item.sujet}

Bonjour ${item.ps_nom},

Je me permets de reprendre contact suite à mon message de ${daysAgo(item.sent_at)}.

La formation "${item.formation_nom}" est toujours disponible et intégralement prise en charge par l'ANDPC. Si vous avez des questions sur le processus d'inscription ou souhaitez que je vous guide, n'hésitez pas à me contacter.

À très vite,
${item.commercial_name}
---

👉 Fiche HubSpot : https://app-eu1.hubspot.com/contacts/26228968/contacts/${item.ps_hubspot_id}`
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(new Date(iso))
  } catch { return iso }
}

function daysAgo(iso: string): string {
  try {
    const days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000)
    return `il y a ${days} jour${days > 1 ? 's' : ''}`
  } catch { return 'récemment' }
}

async function sendSlackDM(userId: string, text: string) {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN manquant')

  const headers = {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  }

  // Étape 1 : ouvrir (ou récupérer) le canal DM
  // conversations.open crée le canal si besoin — aucune action requise du commercial
  const openRes = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers,
    body: JSON.stringify({ users: userId }),
  })
  const openData = await openRes.json()
  if (!openData.ok) throw new Error(`Slack conversations.open error: ${openData.error}`)

  const channelId = openData.channel.id

  // Étape 2 : envoyer le message dans ce canal DM
  const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers,
    body: JSON.stringify({ channel: channelId, text, mrkdwn: true }),
  })
  const msgData = await msgRes.json()
  if (!msgData.ok) throw new Error(`Slack chat.postMessage error: ${msgData.error}`)
}