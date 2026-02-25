import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  // Verify cron secret
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date().toISOString().split('T')[0]
  let notified = 0
  let errors: string[] = []

  try {
    if (!process.env.KV_REST_API_URL) {
      return NextResponse.json({ message: 'KV non configuré — relances désactivées' })
    }

    const { kv } = await import('@vercel/kv')
    
    // Scan all relance keys
    const keys = await kv.keys('relance:*')

    for (const key of keys) {
      const item = await kv.get<any>(key)
      if (!item || item.relance_at !== today) continue

      // Send Slack DM to the commercial
      try {
        const slackMsg = buildSlackMessage(item)
        await sendSlackDM(item.commercial_slack_id, slackMsg)
        await kv.del(key) // Clean up after sending
        notified++
      } catch (e: any) {
        errors.push(`${key}: ${e.message}`)
      }
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }

  return NextResponse.json({ date: today, notified, errors })
}

function buildSlackMessage(item: any): string {
  return `*📬 Relance J+3 — ${item.ps_nom}*

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

👉 Contact HubSpot : https://app.hubspot.com/contacts/0/contact/${item.ps_hubspot_id}`
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

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: userId, text, mrkdwn: true }),
  })

  const data = await res.json()
  if (!data.ok) throw new Error(`Slack error: ${data.error}`)
}
