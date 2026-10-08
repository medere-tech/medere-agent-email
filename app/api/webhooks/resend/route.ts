import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { getKv } from '@/lib/kv'
import { applyEvent, firstHumanClick, markOnce, type TrackingEvent } from '@/lib/tracking'
import { createNote } from '@/lib/hubspot'
import { enqueueNote } from '@/lib/note-queue'
import { hubspotContactUrl, sendSlackDM } from '@/lib/slack'
import { FIRST_CLICK_CONFIRM_DELAY_MS } from '@/lib/config'

const resend = new Resend(process.env.RESEND_API_KEY!)

const DEDUP_TTL = 60 * 60 * 24 * 7 // Resend rejoue un webhook pendant quelques jours au maximum

// Événements Resend traités → fait enregistré sur l'envoi (voir EVENT_SCRIPT dans lib/kv-schema.ts)
const EVENTS: Record<string, TrackingEvent> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
}

export async function POST(req: NextRequest) {
  // 1. Vérification de signature : seul cas qui renvoie une erreur à Resend
  let event: ReturnType<typeof resend.webhooks.verify>
  const svixId = req.headers.get('svix-id') ?? ''
  try {
    // CRITIQUE : utiliser le body brut pour la vérification de signature
    const payload = await req.text()

    event = resend.webhooks.verify({
        payload,
        headers: {
            id: svixId,
            timestamp: req.headers.get('svix-timestamp') ?? '',
            signature: req.headers.get('svix-signature') ?? '',
        },
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
    })
  } catch (e: any) {
    console.error('[WEBHOOK] Signature invalide:', e.message)
    return NextResponse.json({ error: 'Invalid webhook' }, { status: 400 })
  }

  // 2. Signature valide → toujours 2xx. Une erreur de traitement est journalisée
  // mais ne provoque pas de rejeu (les rejeux créaient des Notes HubSpot en double).
  try {
    await handleEvent(event, svixId)
  } catch (e: any) {
    console.error('[WEBHOOK] Erreur de traitement:', e.message)
  }
  return NextResponse.json({ received: true })
}

async function handleEvent(event: ReturnType<typeof resend.webhooks.verify>, svixId: string) {
  const data = event.data as any
  console.log('[WEBHOOK] Event reçu:', event.type, data?.email_id)

  const kind = EVENTS[event.type]
  if (!kind) return

  const emailId = data?.email_id
  if (!emailId) return

  const kv = getKv()

  // Dédoublonnage : un même événement (même svix-id) n'est traité qu'une fois
  if (svixId) {
    const first = await kv.set(`webhook_event:${svixId}`, 1, { nx: true, ex: DEDUP_TTL })
    if (first === null) {
      console.log('[WEBHOOK] Événement déjà traité, ignoré:', svixId)
      return
    }
  }

  // Date de l'événement chez Resend (et non de réception) : un rejeu tardif ne fausse
  // pas les dates affichées. Pour un clic, Resend fournit en plus l'heure réelle du clic.
  const createdAt = new Date((event as any).created_at || '')
  const eventAt = Number.isFinite(createdAt.getTime()) ? createdAt : new Date()
  const click = data?.click && typeof data.click === 'object'
    ? { link: data.click.link, timestamp: data.click.timestamp, userAgent: data.click.userAgent }
    : {}

  const result = await applyEvent(emailId, kind, eventAt, typeof data?.message_id === 'string' ? data.message_id : '', click)

  if (!result.tracked) {
    // Inclut les copies envoyées au commercial (jamais enregistrées dans le KV)
    console.log('[WEBHOOK] email_id non trouvé dans KV:', emailId)
    return
  }
  const auto = result.autoReason ? `(automatique : ${result.autoReason})` : ''
  const reclassified = result.reclassified ? `(${result.reclassified} clic(s) précédent(s) reclassé(s) automatique(s))` : ''
  console.log('[WEBHOOK] Statut KV mis à jour:', emailId, kind, auto, reclassified, '→', result.statut)

  // Une seule Note HubSpot par type (première ouverture, premier clic humain), jamais pour
  // un clic automatique ; le verrou est posé atomiquement par le script.
  const entry = result.entry
  if (!entry) return
  let noteKind: 'opened' | 'clicked' | null = result.createOpenNote ? 'opened' : result.createClickNote ? 'clicked' : null
  if (!noteKind) return

  let noteDate = eventAt
  if (noteKind === 'clicked') {
    // Laisse arriver les autres clics d'une éventuelle rafale, puis relit le premier clic humain
    await new Promise((r) => setTimeout(r, FIRST_CLICK_CONFIRM_DELAY_MS))
    const firstClick = await firstHumanClick(emailId)
    if (!firstClick) {
      await kv.del(`hubspot_note:${emailId}:clicked`)
      console.log('[WEBHOOK] Premier clic reclassé automatique, Note non créée:', emailId)
      noteKind = null
    } else {
      noteDate = new Date(firstClick)
    }
  }
  if (!noteKind) return

  const emoji = noteKind === 'opened' ? '👁️' : '🖱️'
  const action = noteKind === 'opened' ? 'Email ouvert' : 'Email cliqué'
  const date = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
  }).format(noteDate)
  const body = `${emoji} <b>${action} le ${date}</b><br><br><b>Sujet :</b> ${entry.sujet}<br><b>Commercial :</b> ${entry.commercial_name}`

  if (entry.contact_id) {
    try {
      await createNote(entry.contact_id, body)
      console.log('[WEBHOOK] Note HubSpot créée pour contact:', entry.contact_id)
    } catch (e: any) {
      // Verrou conservé (pas de Note en double) ; la Note est retentée par le cron, alerte si l'échec est définitif
      console.error('[WEBHOOK] Note HubSpot non créée :', e.message)
      await enqueueNote({ contactId: entry.contact_id, body, label: `${action} — « ${entry.sujet} » (${entry.commercial_name})`, firstError: e.message })
    }
  }

  // Premier clic humain : DM au commercial, une seule fois par envoi
  if (noteKind === 'clicked') await notifyFirstClick(emailId, entry, noteDate)
}

// DM Slack « le PS vient de cliquer » au commercial : une seule fois par envoi (click_notified_at),
// jamais pour un clic automatique (appelé après la confirmation du premier clic humain).
async function notifyFirstClick(emailId: string, entry: Record<string, any>, clickedAt: Date) {
  if (!entry.commercial_slack_id) return
  if (!(await markOnce(emailId, 'click_notified_at'))) return
  const heure = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(clickedAt)
  const relance = entry.kind === 'relance' ? ' (ta relance)' : ''
  const text = `*🖱️ ${entry.ps_nom} vient de cliquer dans ton mail${relance}*\n` +
    `« ${entry.sujet} » — formation ${entry.formation_nom}, à ${heure}.\n` +
    `C'est le bon moment pour l'appeler.\n` +
    (entry.contact_id ? `👉 Fiche HubSpot : ${hubspotContactUrl(entry.contact_id)}` : '')
  try {
    await sendSlackDM(entry.commercial_slack_id, text)
    console.log('[WEBHOOK] DM premier clic envoyé :', emailId)
  } catch (e: any) {
    console.error('[WEBHOOK] DM premier clic non envoyé :', emailId, e.message)
  }
}
