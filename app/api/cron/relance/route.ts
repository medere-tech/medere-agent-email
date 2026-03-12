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
    console.log('[CRON] Date today:', today)
    console.log('[CRON] Clés trouvées:', keys.length, keys)

    for (const key of keys) {
      const item = await kv.get<any>(key)
      console.log('[CRON] Item:', key, '→ relance_at:', item?.relance_at, '| match:', item?.relance_at === today)
      if (!item || item.relance_at !== today) continue

      // Send Slack DM to the commercial
      // Vérifier si le PS est déjà inscrit dans Airtable
      try {
        const dejáInscrit = await checkInscriptionAirtable(item.ps_rpps, item.ps_email, item.formation_numero)
        if (dejáInscrit) {
          await kv.del(key) // Supprimer silencieusement — plus besoin de relancer
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

async function checkInscriptionAirtable(rpps: string, email: string, formationNumero: string): Promise<boolean> {
  const BASE_ID = process.env.AIRTABLE_BASE_ID!
  const TOKEN = process.env.AIRTABLE_TOKEN!
  const SESSIONS_TABLE = 'tblGVEqH7KCo2GlXz'
  const INSCRIPTIONS_TABLE = 'tblTOJHEwCQhibcMM'

  try {
    const identifier = rpps || email
    if (!identifier) return false

    // Étape 1 : chercher les inscriptions du PS par RPPS
    const formula = encodeURIComponent(`FIND("${identifier}", ARRAYJOIN({RPPS}, ","))`)
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${INSCRIPTIONS_TABLE}?filterByFormula=${formula}&fields[]=${encodeURIComponent('session_id')}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    )
    const data = await res.json()
    const inscriptions = data.records || []
    if (!inscriptions.length) return false

    // Étape 2 : récupérer les session_ids des inscriptions
    const sessionIds: string[] = inscriptions
      .flatMap((r: any) => r.fields['session_id'] || [])
      .filter(Boolean)
    if (!sessionIds.length) return false

    // Étape 3 : vérifier si l'une de ces sessions appartient à la formation concernée
    const sessionsRes = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${SESSIONS_TABLE}?fields[]=${encodeURIComponent('session_id')}&fields[]=${encodeURIComponent("Numéro d'action DPC")}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    )
    const sessionsData = await sessionsRes.json()
    const allSessions = sessionsData.records || []

    const matchingSessions = allSessions.filter((r: any) =>
      sessionIds.includes(r.fields['session_id'])
    )

    // Vérifie si le numéro de formation correspond
    return matchingSessions.some((r: any) => {
      const nums: string[] = r.fields["Numéro d'action DPC"] || []
      return nums.some((n) => String(n) === String(formationNumero))
    })
  } catch {
    return false // En cas d'erreur, on relance quand même — mieux vaut trop que pas assez
  }
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