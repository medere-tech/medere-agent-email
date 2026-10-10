import { ALERT_SLACK_USER_ID } from '@/lib/config'

// DM Slack (conversations.open crée le canal si besoin, aucune action du destinataire).
// Lève une erreur lisible si Slack refuse.
export async function sendSlackDM(userId: string, text: string): Promise<void> {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN manquant')
  if (!userId) throw new Error('identifiant Slack manquant')
  const headers = {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  }
  const openRes = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers,
    body: JSON.stringify({ users: userId }),
  })
  const openData = await openRes.json()
  if (!openData.ok) throw new Error(`Slack conversations.open : ${openData.error}`)

  const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers,
    body: JSON.stringify({ channel: openData.channel.id, text, mrkdwn: true }),
  })
  const msgData = await msgRes.json()
  if (!msgData.ok) throw new Error(`Slack chat.postMessage : ${msgData.error}`)
}

// Alerte technique (destinataire fixe : ALERT_SLACK_USER_ID). Ne lève jamais : une alerte
// impossible à envoyer est seulement journalisée.
export async function sendAlert(title: string, lines: string[]): Promise<void> {
  const text = `*⚠️ Agent Mail — ${title}*\n${lines.map((l) => `• ${l}`).join('\n')}`
  try {
    await sendSlackDM(ALERT_SLACK_USER_ID, text.slice(0, 3800))
  } catch (e: any) {
    console.error('[ALERTE] DM d’alerte non envoyé :', e.message, '—', title, lines)
  }
}

// Adresse de l'app (liens dans les DM)
export function appUrl(): string {
  return (process.env.NEXTAUTH_URL || 'https://medere-agent-email-dpc.vercel.app').replace(/\/$/, '')
}

export function hubspotContactUrl(contactId: string): string {
  return `https://app-eu1.hubspot.com/contacts/26228968/contacts/${contactId}`
}
