/**
 * Données de test pour l'Agent Mail DPC — base KV de TEST uniquement.
 *
 * Usage (Node ≥ 22.18, exécute le TypeScript sans dépendance) :
 *   TEST_KV_HOST=<hôte-kv-de-test> node scripts/seed-test.ts seed [--relance]
 *   TEST_KV_HOST=<hôte-kv-de-test> node scripts/seed-test.ts webhook <opened|clicked> <email_id>
 *   TEST_KV_HOST=<hôte-kv-de-test> node scripts/seed-test.ts clean
 *
 * Variables lues dans .env.local (ou le fichier pointé par ENV_FILE) :
 *   KV_REST_API_URL, KV_REST_API_TOKEN, RESEND_WEBHOOK_SECRET (commande webhook)
 * Variables à fournir (environnement ou .env.local) :
 *   TEST_KV_HOST            hôte de la base KV de test — le script refuse toute autre base
 *   TEST_HUBSPOT_CONTACT_ID contact HubSpot de test (ex. 18421683158)
 *   TEST_PS_EMAIL           adresse de test (ex. dethie@medere.fr)
 *   TEST_SLACK_USER_ID      Slack ID qui recevra les DM de relance (option --relance)
 *   TEST_APP_URL            URL de l'app locale (défaut http://localhost:3000)
 *
 * Clés créées (toutes préfixées pour être reconnaissables et supprimables) :
 *   email_track:test-seed-envoye   entrée au format actuel, statut "envoyé"
 *   email_track:test-legacy        entrée au format ancien (statut "ouvert", opened_at, sans first_*)
 *   emails_index                   + les deux ids ci-dessus
 *   relance:test-seed-today        (option --relance) relance datée d'aujourd'hui → 1 DM au prochain cron
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SEED_IDS = ['test-seed-envoye', 'test-legacy']
const RELANCE_KEY = 'relance:test-seed-today'
const WEBHOOK_PREFIX = 'msg_seedtest_'

function loadEnv(): Record<string, string> {
  const file = resolve(process.env.ENV_FILE || '.env.local')
  const fromFile = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]
      })
  )
  return { ...fromFile, ...(process.env as Record<string, string>) }
}

const env = loadEnv()

function required(name: string): string {
  const v = env[name]
  if (!v) {
    console.error(`Variable manquante : ${name}`)
    process.exit(1)
  }
  return v
}

// Garde-fou : on ne touche qu'à la base KV de test explicitement désignée
function assertTestKv(): void {
  const expected = required('TEST_KV_HOST')
  const actual = new URL(required('KV_REST_API_URL')).host
  if (actual !== expected) {
    console.error(`REFUS : KV_REST_API_URL pointe sur ${actual}, pas sur la base de test ${expected}.`)
    process.exit(1)
  }
}

async function kv(...command: (string | number)[]): Promise<unknown> {
  const res = await fetch(required('KV_REST_API_URL'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${required('KV_REST_API_TOKEN')}` },
    body: JSON.stringify(command.map(String)),
  })
  const json = (await res.json()) as { result?: unknown; error?: string }
  if (json.error) throw new Error(json.error)
  return json.result
}

async function scan(pattern: string): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = (await kv('SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000)) as [string, string[]]
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  return keys
}

async function seed(withRelance: boolean): Promise<void> {
  const contactId = required('TEST_HUBSPOT_CONTACT_ID')
  const psEmail = required('TEST_PS_EMAIL')
  const now = new Date()
  const iso = now.toISOString()
  const base = {
    contact_id: contactId,
    ps_nom: 'Monsieur Test Seed',
    ps_email: psEmail,
    commercial_name: 'Commercial de test',
    formation_nom: 'Formation de test',
  }

  // Format actuel (créé par /api/send)
  await kv('SET', 'email_track:test-seed-envoye', JSON.stringify({
    ...base, sujet: '[TEST-SEED] entrée au format actuel', statut: 'envoyé',
    sent_at: iso, opened_at: null, clicked_at: null,
  }))
  // Format ancien (avant first_opened_at / first_clicked_at) : déjà ouvert, Note "ouvert" supposée créée
  const hier = new Date(now.getTime() - 86400000)
  await kv('SET', 'email_track:test-legacy', JSON.stringify({
    ...base, sujet: '[TEST-SEED] entrée au format ancien', statut: 'ouvert',
    sent_at: hier.toISOString(), opened_at: new Date(hier.getTime() + 3600000).toISOString(), clicked_at: null,
  }))
  for (const id of SEED_IDS) await kv('ZADD', 'emails_index', now.getTime(), id)

  const created = [...SEED_IDS.map((id) => `email_track:${id}`), 'emails_index (+2 membres)']

  if (withRelance) {
    const slackId = required('TEST_SLACK_USER_ID')
    await kv('SET', RELANCE_KEY, JSON.stringify({
      commercial_slack_id: slackId, commercial_name: 'Commercial de test',
      ps_nom: '[TEST-SEED] PS de test', ps_email: psEmail, ps_rpps: '', ps_hubspot_id: contactId,
      formation_nom: 'Formation de test', formation_numero: '00000000000',
      sujet: '[TEST-SEED] relance', corps: 'test',
      sent_at: new Date(now.getTime() - 3 * 86400000).toISOString(),
      relance_at: iso.split('T')[0],
    }), 'EX', 2 * 86400)
    created.push(`${RELANCE_KEY} (expire dans 48 h)`)
  }

  console.log('Données de test créées :')
  for (const k of created) console.log(`  - ${k}`)
  console.log('\nWebhooks signés : node scripts/seed-test.ts webhook opened test-seed-envoye')
}

async function webhook(kind: string, emailId: string): Promise<void> {
  if (kind !== 'opened' && kind !== 'clicked') {
    console.error('Type attendu : opened ou clicked')
    process.exit(1)
  }
  const msgId = `${WEBHOOK_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const type = `email.${kind}`
  const payload = JSON.stringify({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: emailId, created_at: new Date().toISOString(), to: [env.TEST_PS_EMAIL || ''], subject: 'test' },
  })
  // Signature Svix (format vérifié par resend.webhooks.verify) : HMAC-SHA256 de "id.timestamp.payload"
  // avec le secret whsec_… décodé en base64
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = Buffer.from(required('RESEND_WEBHOOK_SECRET').replace(/^whsec_/, ''), 'base64')
  const signature = 'v1,' + createHmac('sha256', key).update(`${msgId}.${timestamp}.${payload}`).digest('base64')
  const res = await fetch(`${env.TEST_APP_URL || 'http://localhost:3000'}/api/webhooks/resend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': msgId,
      'svix-timestamp': timestamp,
      'svix-signature': signature,
    },
    body: payload,
  })
  console.log(`${type} ${emailId} → HTTP ${res.status} (svix-id ${msgId})`)
}

async function clean(): Promise<void> {
  const keys = [
    ...SEED_IDS.map((id) => `email_track:${id}`),
    ...SEED_IDS.flatMap((id) => [`hubspot_note:${id}:opened`, `hubspot_note:${id}:clicked`]),
    RELANCE_KEY,
    ...(await scan(`webhook_event:${WEBHOOK_PREFIX}*`)),
  ]
  let deleted = 0
  for (const k of keys) deleted += Number(await kv('DEL', k))
  for (const id of SEED_IDS) await kv('ZREM', 'emails_index', id)
  console.log(`${deleted} clé(s) supprimée(s), ${SEED_IDS.length} membre(s) retiré(s) de emails_index.`)
  console.log('Les Notes HubSpot éventuellement créées sur le contact de test sont à supprimer à part (voir docs/TESTS.md).')
}

async function main(): Promise<void> {
  assertTestKv()
  const [cmd = 'seed', ...args] = process.argv.slice(2)
  if (cmd === 'seed') return seed(args.includes('--relance'))
  if (cmd === 'webhook') return webhook(args[0], args[1])
  if (cmd === 'clean') return clean()
  console.error(`Commande inconnue : ${cmd} (seed | webhook | clean)`)
  process.exit(1)
}

main().catch((e: unknown) => {
  console.error('ERREUR', e instanceof Error ? e.message : e)
  process.exit(1)
})
