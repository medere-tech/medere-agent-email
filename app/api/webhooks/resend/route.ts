import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY!)

// Mise à jour atomique de email_track:{id} (lecture + écriture dans Redis, sans
// course entre un "opened" et un "clicked" simultanés). Le format JSON existant
// est conservé, /suivi le lit sans changement.
//   - statut monotone : envoyé < ouvert < cliqué, jamais de régression
//   - first_opened_at / first_clicked_at écrits une seule fois
//   - opened_at / clicked_at (affichés par /suivi) figés sur la première occurrence
//   - entrée antérieure déjà ouverte/cliquée : first_* repris de opened_at/clicked_at
//     et verrou de Note posé (l'ancien webhook a déjà créé la Note HubSpot)
// KEYS[1] = email_track:{id}, KEYS[2] = hubspot_note:{id}:{kind}
// ARGV[1] = 'opened' | 'clicked', ARGV[2] = date ISO
// Retour : 1 si l'email est suivi, 0 sinon
const UPDATE_TRACKING_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local d = cjson.decode(raw)

local function isset(v) return v ~= nil and v ~= cjson.null and v ~= '' end

local firstField, field, target
if ARGV[1] == 'opened' then
  firstField, field, target = 'first_opened_at', 'opened_at', 'ouvert'
else
  firstField, field, target = 'first_clicked_at', 'clicked_at', 'cliqué'
end

if not isset(d[firstField]) then
  if isset(d[field]) then
    d[firstField] = d[field]
    redis.call('SET', KEYS[2], 'legacy')
  else
    d[firstField] = ARGV[2]
    d[field] = ARGV[2]
  end
end

local rank = { ['envoyé'] = 0, ['ouvert'] = 1, ['cliqué'] = 2 }
if rank[target] > (rank[d.statut] or 0) then d.statut = target end

-- Sur Upstash, cjson décode null en nil et cjson.null vaut nil : une clé à null
-- disparaîtrait à la réécriture. On la rajoute dans la chaîne JSON encodée.
local json = cjson.encode(d)
local nulls = {}
if d.opened_at == nil then table.insert(nulls, '"opened_at":null') end
if d.clicked_at == nil then table.insert(nulls, '"clicked_at":null') end
if #nulls > 0 then
  if json == '{}' then
    json = '{' .. table.concat(nulls, ',') .. '}'
  else
    json = string.sub(json, 1, -2) .. ',' .. table.concat(nulls, ',') .. '}'
  end
end

redis.call('SET', KEYS[1], json)
return 1
`

const DEDUP_TTL = 60 * 60 * 24 * 7 // Resend rejoue un webhook pendant quelques jours au maximum

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

  // Uniquement email.opened et email.clicked
  if (event.type !== 'email.opened' && event.type !== 'email.clicked') return

  const emailId = data?.email_id
  if (!emailId) return

  const { kv } = await import('@vercel/kv')

  // Dédoublonnage : un même événement (même svix-id) n'est traité qu'une fois
  if (svixId) {
    const first = await kv.set(`webhook_event:${svixId}`, 1, { nx: true, ex: DEDUP_TTL })
    if (first === null) {
      console.log('[WEBHOOK] Événement déjà traité, ignoré:', svixId)
      return
    }
  }

  const kind = event.type === 'email.opened' ? 'opened' : 'clicked'
  const trackKey = `email_track:${emailId}`
  const noteKey = `hubspot_note:${emailId}:${kind}`

  const tracked = await kv.eval<[string, string], number>(
    UPDATE_TRACKING_SCRIPT,
    [trackKey, noteKey],
    [kind, new Date().toISOString()]
  )

  if (!tracked) {
    // Inclut les copies envoyées au commercial (jamais enregistrées dans le KV)
    console.log('[WEBHOOK] email_id non trouvé dans KV:', emailId)
    return
  }
  console.log('[WEBHOOK] Statut KV mis à jour:', emailId, kind)

  // Une seule Note HubSpot par type d'événement et par email
  const noteLock = await kv.set(noteKey, new Date().toISOString(), { nx: true })
  if (noteLock === null) return

  const entry = await kv.get<Record<string, any>>(trackKey)
  if (!entry) return

  const emoji = kind === 'opened' ? '👁️' : '🖱️'
  const action = kind === 'opened' ? 'ouvert' : 'cliqué'
  const date = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
  }).format(new Date())

  try {
    await logNoteHubSpot(
      entry.contact_id,
      `${emoji} <b>Email ${action} le ${date}</b><br><br><b>Sujet :</b> ${entry.sujet}<br><b>Commercial :</b> ${entry.commercial_name}`
    )
    console.log('[WEBHOOK] Note HubSpot créée pour contact:', entry.contact_id)
  } catch (e) {
    // Libère le verrou : le prochain événement du même type pourra recréer la Note
    await kv.del(noteKey)
    throw e
  }
}

async function logNoteHubSpot(contactId: string, body: string) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: body,
      },
      associations: [{
        to: { id: parseInt(contactId) },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
      }],
    }),
  })
  if (!res.ok) throw new Error(`HubSpot note error: ${await res.text()}`)
}
