import { NextRequest, NextResponse } from 'next/server'
import { isPsInscritAFormation } from '@/lib/airtable'
import { getKv, kvConfigured } from '@/lib/kv'
import { KEYS } from '@/lib/kv-schema'
import { markOnce, purgeExpired } from '@/lib/tracking'
import { RETENTION_DAYS, SLACK_RELANCE_MAX_ATTEMPTS } from '@/lib/config'
import { RELANCE_STATUS_LABEL, relanceStatus } from '@/lib/relance'
import { processNoteRetries } from '@/lib/note-queue'
import { appUrl, hubspotContactUrl, sendAlert, sendSlackDM } from '@/lib/slack'

export const dynamic = 'force-dynamic'

// Passage quotidien (Vercel Cron, 8h UTC) :
//   1. relances J+3 par DM Slack (relances_due, rattrapage des jours manqués)
//   2. purge RGPD
//   3. nouveaux essais des Notes HubSpot en échec
//   4. alerte en DM (ALERT_SLACK_USER_ID) s'il y a eu des erreurs
export async function GET(req: NextRequest) {
  // Sans CRON_SECRET, la valeur attendue deviendrait "Bearer undefined" :
  // n'importe qui pourrait déclencher le cron.
  if (!process.env.CRON_SECRET) {
    console.error('[CRON] CRON_SECRET manquant — exécution refusée')
    return NextResponse.json({ error: 'Configuration serveur invalide (CRON_SECRET manquant)' }, { status: 500 })
  }
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!kvConfigured()) {
    return NextResponse.json({ message: 'KV non configuré — relances désactivées' })
  }

  const report = {
    date: new Date().toISOString().split('T')[0],
    notified: 0,
    skipped: { inscrit: 0, adresse_invalide: 0, indesirable: 0, relance_mail: 0, introuvable: 0 },
    retried: 0,
    purged: 0,
    notes: { created: 0, requeued: 0, abandoned: 0 },
    errors: [] as string[],
  }

  try {
    await processDueRelances(report)
  } catch (e: any) {
    console.error('[CRON] Relances en échec :', e.message)
    report.errors.push(`relances : ${e.message}`)
  }

  // Rétention RGPD : purge des envois de plus de RETENTION_DAYS jours
  try {
    report.purged = await purgeExpired()
    if (report.purged) console.log(`[CRON] Purge RGPD : ${report.purged} envoi(s) de plus de ${RETENTION_DAYS} jours supprimé(s)`)
  } catch (e: any) {
    console.error('[CRON] Purge RGPD en échec:', e.message)
    report.errors.push(`purge RGPD : ${e.message}`)
  }

  // Notes HubSpot en échec (l'alerte d'un échec définitif part depuis processNoteRetries)
  try {
    const notes = await processNoteRetries()
    report.notes = { created: notes.created, requeued: notes.requeued, abandoned: notes.abandoned }
    report.errors.push(...notes.errors)
  } catch (e: any) {
    console.error('[CRON] Nouveaux essais des Notes en échec :', e.message)
    report.errors.push(`Notes HubSpot : ${e.message}`)
  }

  if (report.errors.length) {
    await sendAlert(`passage quotidien du ${report.date} : ${report.errors.length} erreur(s)`, report.errors)
  }
  return NextResponse.json(report)
}

type Report = {
  notified: number
  skipped: Record<'inscrit' | 'adresse_invalide' | 'indesirable' | 'relance_mail' | 'introuvable', number>
  retried: number
  errors: string[]
}

// Relances dont l'échéance est passée (aujourd'hui ou un jour manqué). Chaque relance est
// « réclamée » par ZREM : deux passages simultanés n'envoient jamais deux DM.
async function processDueRelances(report: Report) {
  const kv = getKv()
  const due = (await kv.zrange(KEYS.relancesDue, 0, Date.now(), { byScore: true })) as string[]
  for (const member of due) {
    if (Number(await kv.zrem(KEYS.relancesDue, member)) !== 1) continue
    try {
      if (member.startsWith('legacy:')) await handleLegacy(member, report)
      else await handleEntry(member, report)
    } catch (e: any) {
      console.error('[CRON] Relance', member, ':', e.message)
      report.errors.push(`relance ${member} : ${e.message}`)
    }
  }
}

function frenchDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' }).format(new Date(iso))
  } catch {
    return iso
  }
}

// Le PS est-il inscrit ? Airtable indisponible : la relance part quand même (mieux vaut trop
// que pas assez), l'erreur est remontée dans l'alerte.
async function inscrit(member: string, rpps: string, email: string, numero: string, report: Report): Promise<boolean> {
  try {
    return await isPsInscritAFormation(rpps || '', email || '', numero || '')
  } catch (e: any) {
    report.errors.push(`${member} : vérification de l'inscription impossible (${e.message}) — relance envoyée quand même`)
    return false
  }
}

// Slack en échec : nouvel essai au prochain passage, jusqu'à SLACK_RELANCE_MAX_ATTEMPTS
async function retryLater(member: string, error: string, report: Report) {
  const kv = getKv()
  const attempts = await kv.incr(`slack_relance_attempts:${member}`)
  await kv.expire(`slack_relance_attempts:${member}`, 7 * 86400)
  if (attempts < SLACK_RELANCE_MAX_ATTEMPTS) {
    await kv.zadd(KEYS.relancesDue, { score: Date.now() + 86400000, member })
    report.retried++
    report.errors.push(`${member} : DM Slack non envoyé (${error}) — nouvel essai demain (${attempts}/${SLACK_RELANCE_MAX_ATTEMPTS})`)
  } else {
    report.errors.push(`${member} : DM Slack abandonné après ${attempts} essais (${error})`)
  }
}

async function handleEntry(id: string, report: Report) {
  const entry = await getKv().get<Record<string, any>>(KEYS.track(id))
  if (!entry) { report.skipped.introuvable++; return }
  if (entry.relance_id) { report.skipped.relance_mail++; return }
  if (entry.statut === 'bounce') { report.skipped.adresse_invalide++; return }
  if (entry.statut === 'plainte') { report.skipped.indesirable++; return }
  if (await inscrit(id, entry.ps_rpps, entry.ps_email, entry.formation_numero, report)) { report.skipped.inscrit++; return }
  if (!entry.commercial_slack_id) {
    report.errors.push(`${id} : pas d'identifiant Slack pour ${entry.commercial_name} — relance de ${entry.ps_nom} non notifiée`)
    return
  }

  const statut = relanceStatus(entry)
  const constat = {
    non_ouvert: "Il ne l'a pas encore ouvert.",
    ouvert_sans_clic: "Il l'a ouvert, sans cliquer.",
    clique: 'Il a cliqué dans le mail.',
  }[statut]
  const text = `*📬 Relance à faire : ${entry.ps_nom}*\n` +
    `Tu lui as envoyé un mail le ${frenchDate(entry.sent_at)} pour la formation *« ${entry.formation_nom} »*.\n` +
    `Statut : *${RELANCE_STATUS_LABEL[statut]}*. ${constat} Il ne s'est pas encore inscrit.\n` +
    `👉 <${appUrl()}/suivi?relance=${encodeURIComponent(id)}|Préparer la relance par mail>\n` +
    (entry.contact_id ? `👉 Fiche HubSpot : ${hubspotContactUrl(entry.contact_id)}` : '')
  try {
    await sendSlackDM(entry.commercial_slack_id, text)
  } catch (e: any) {
    await retryLater(id, e.message, report)
    return
  }
  await markOnce(id, 'slack_relance_at')
  report.notified++
}

// Ancienne clé relance:{ts} non rattachée à un envoi (reprise par la migration)
async function handleLegacy(member: string, report: Report) {
  const kv = getKv()
  const key = member.slice('legacy:'.length)
  const item = await kv.get<Record<string, any>>(key)
  if (!item) { report.skipped.introuvable++; return }
  if (await inscrit(member, item.ps_rpps, item.ps_email, item.formation_numero, report)) {
    await kv.del(key)
    report.skipped.inscrit++
    return
  }
  if (!item.commercial_slack_id) {
    report.errors.push(`${member} : pas d'identifiant Slack pour ${item.commercial_name} — relance de ${item.ps_nom} non notifiée`)
    return
  }
  const text = `*📬 Relance à faire : ${item.ps_nom}*\n` +
    `Tu lui as envoyé un mail le ${frenchDate(item.sent_at)} pour la formation *« ${item.formation_nom} »*. Il ne s'est pas encore inscrit.\n` +
    `👉 <${appUrl()}/suivi|Voir le suivi des envois>\n` +
    (item.ps_hubspot_id ? `👉 Fiche HubSpot : ${hubspotContactUrl(item.ps_hubspot_id)}` : '')
  try {
    await sendSlackDM(item.commercial_slack_id, text)
  } catch (e: any) {
    await retryLater(member, e.message, report)
    return
  }
  await kv.del(key)
  report.notified++
}
