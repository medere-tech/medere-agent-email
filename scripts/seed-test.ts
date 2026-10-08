/**
 * Données de test pour l'Agent Mail DPC — base KV de TEST uniquement.
 *
 * Usage (Node ≥ 22.18, exécute le TypeScript sans dépendance) :
 *   TEST_KV_HOST=<hôte-kv-de-test> node scripts/seed-test.ts seed [--relance] [--names] [--clicks] [--purge] [--relances] [--historique]
 *   TEST_KV_HOST=<hôte-kv-de-test> node scripts/seed-test.ts webhook <type> <email_id> [--created-at=<iso>] [--message-id=<id>] [--svix-id=<suffixe>]
 *       type : delivered | bounced | complained | opened | clicked
 *       --created-at : date de l'événement (défaut : maintenant)
 *       clicked : objet click (lien, heure, navigateur) ; --link=<url>, --click-at=<iso> (heure réelle
 *                 du clic, sert aux rafales), --ua=<navigateur> (--ua= vide = robot), --no-click
 *   TEST_KV_HOST=<hôte-kv-de-test> node scripts/seed-test.ts clean
 *   TEST_KV_HOST=<hôte-kv-de-test> node scripts/seed-test.ts check-slack   refuse si une clé contient un Slack ID ≠ TEST_SLACK_USER_ID
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
 * Clés créées (toutes préfixées pour être reconnaissables et supprimables), toutes au format
 * d'avant la migration v2 (scripts/migrate-kv.ts), pour tester la lecture des anciennes données :
 *   email_track:test-seed-envoye     format phase 1, statut "envoyé" (envoyé il y a 10 min)
 *   email_track:test-legacy          format d'origine (statut "ouvert", opened_at, sans first_*)
 *   email_track:test-legacy-kaoufer  (--names) commercial « Kaoufer Guercif » → rattaché à kaoufer@medere.fr
 *   email_track:test-legacy-loane    (--names) commercial « Loane Deluge » → nom:loane-deluge (fiche justine.m@)
 *   email_track:test-click-a|b|c     (--clicks) envois neufs pour les rafales de clics
 *   email_track:test-purge-*         (--purge) envois au PS de test au nom de Zacharie / Kaoufer (adresse seule)
 *   email_track:test-autre-ps-*      (--purge) envois à un PS fictif (99999999999) qui doivent rester intacts
 *   relance:test-purge-zacharie / relance:test-autre-ps   (--purge) anciennes relances (PS de test / autre PS)
 *   email_track:test-rel-*           (--relances) envois de la fiche Dethie Faye, relance J+3 due (non ouvert il y a 2 jours,
 *                                    ouvert, cliqué, adresse invalide, indésirable, déjà relancé, sans Slack) + un envoi
 *                                    de « Zacharie » sans échéance (refus de relance) ; relance:test-rel-legacy (legacy)
 *   emails_index                     + les ids ci-dessus
 *   relance:test-seed-today          (--relance) relance du jour, rattachable à test-seed-envoye
 *   relance:test-seed-orphan         (--relance) relance sans envoi correspondant (reprise en legacy)
 *
 * Les compteurs stats:day:* et meta:commerciaux alimentés par ces entrées après migration ne
 * sont pas retirés par "clean" : pour un nettoyage complet, restaurer l'export de début de
 * session (voir docs/TESTS.md).
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CLICK_IDS = ['test-click-a', 'test-click-b', 'test-click-c']
// --purge : envois au PS de test au nom de vrais commerciaux (à purger) et envois à un PS fictif (à garder)
const PURGE_IDS = ['test-purge-zacharie', 'test-purge-kaoufer-email', 'test-autre-ps-zacharie', 'test-autre-ps-sarah']
const OTHER_PS = { contact_id: '99999999999', ps_email: 'ps.fictif@example.invalid', ps_nom: 'Docteur PS Fictif' }
// --relances : envois de la fiche de test (Dethie Faye) avec relance J+3 due, statuts variés
const RELANCE_IDS = ['test-rel-non-ouvert', 'test-rel-ouvert', 'test-rel-clique', 'test-rel-bounce', 'test-rel-plainte', 'test-rel-deja', 'test-rel-sans-slack', 'test-rel-zacharie']
// --historique : envois récents au contact de test (alerte « déjà contacté » de l'étape 4)
const HISTORY_IDS = ['test-hist-2j', 'test-hist-6j', 'test-hist-6j-relance', 'test-hist-20j', 'test-hist-autre']
const SEED_IDS = ['test-seed-envoye', 'test-legacy', 'test-legacy-kaoufer', 'test-legacy-loane', ...CLICK_IDS, ...PURGE_IDS, ...RELANCE_IDS, ...HISTORY_IDS]
const RELANCE_KEYS = ['relance:test-seed-today', 'relance:test-seed-orphan', 'relance:test-purge-zacharie', 'relance:test-autre-ps', 'relance:test-rel-legacy']
const SEED_COMMERCIAL_KEYS = ['nom:commercial-de-test', 'kaoufer@medere.fr', 'nom:loane-deluge', 'zacharie@medere.fr', 'sarah.s@medere.fr']
const WEBHOOK_PREFIX = 'msg_seedtest_'
const WEBHOOK_TYPES = ['delivered', 'bounced', 'complained', 'opened', 'clicked']

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

function option(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
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

async function seed(withRelance: boolean, withNames: boolean, withClicks: boolean, withPurge: boolean, withRelances: boolean, withHistory: boolean): Promise<void> {
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

  // Format phase 1 (avant v2), envoyé il y a 10 minutes : un webhook « maintenant » est humain
  const sentAt = new Date(now.getTime() - 10 * 60000).toISOString()
  const envoyeSujet = '[TEST-SEED] entrée au format phase 1'
  await kv('SET', 'email_track:test-seed-envoye', JSON.stringify({
    ...base, sujet: envoyeSujet, statut: 'envoyé',
    sent_at: sentAt, opened_at: null, clicked_at: null,
  }))
  // Format d'origine (avant first_opened_at / first_clicked_at) : déjà ouvert, Note "ouvert" supposée créée
  const hier = new Date(now.getTime() - 86400000)
  await kv('SET', 'email_track:test-legacy', JSON.stringify({
    ...base, sujet: '[TEST-SEED] entrée au format ancien', statut: 'ouvert',
    sent_at: hier.toISOString(), opened_at: new Date(hier.getTime() + 3600000).toISOString(), clicked_at: null,
  }))
  const ids = ['test-seed-envoye', 'test-legacy']
  await kv('ZADD', 'emails_index', Date.parse(sentAt), 'test-seed-envoye')
  await kv('ZADD', 'emails_index', hier.getTime(), 'test-legacy')

  if (withNames) {
    // Anciens envois d'avant-hier, pour la correspondance nom → email de la migration
    const avantHier = new Date(now.getTime() - 2 * 86400000).toISOString()
    for (const [id, name] of [['test-legacy-kaoufer', 'Kaoufer Guercif'], ['test-legacy-loane', 'Loane Deluge']]) {
      await kv('SET', `email_track:${id}`, JSON.stringify({
        ...base, commercial_name: name, sujet: `[TEST-SEED] ancien envoi de ${name}`, statut: 'cliqué',
        sent_at: avantHier, opened_at: avantHier, clicked_at: avantHier,
      }))
      await kv('ZADD', 'emails_index', Date.parse(avantHier), id)
      ids.push(id)
    }
  }

  if (withClicks) {
    // Envois neufs (jamais ouverts ni cliqués), pour les scénarios de rafale de clics
    for (const id of CLICK_IDS) {
      await kv('SET', `email_track:${id}`, JSON.stringify({
        ...base, sujet: `[TEST-SEED] clics ${id.slice(-1)}`, statut: 'envoyé',
        sent_at: sentAt, opened_at: null, clicked_at: null,
      }))
      await kv('ZADD', 'emails_index', Date.parse(sentAt), id)
      ids.push(id)
    }
  }

  if (withHistory) {
    // idx:contact du contact de test : 2 jours (Dethie, Ouvert), 6 jours (Zacharie, Cliqué) + sa relance
    // 4 jours, 20 jours (hors fenêtre de 14 jours) ; un envoi d'il y a 1 jour à un autre contact (0)
    const ago = (d: number) => now.getTime() - d * 86400000
    const hist: [string, number, string, Record<string, unknown>][] = [
      ['test-hist-2j', ago(2), contactId, { statut: 'ouvert', commercial_name: 'Dethie Faye', formation_nom: 'Repérer et prendre en charge les symptômes associés au COVID long' }],
      ['test-hist-6j', ago(6), contactId, { statut: 'cliqué', commercial_name: 'Zacharie Groch', formation_nom: 'Formation de test (historique)', relance_id: 'test-hist-6j-relance' }],
      ['test-hist-6j-relance', ago(4), contactId, { statut: 'délivré', kind: 'relance', parent_id: 'test-hist-6j', commercial_name: 'Zacharie Groch', formation_nom: 'Formation de test (historique)' }],
      ['test-hist-20j', ago(20), contactId, { statut: 'ouvert', commercial_name: 'Dethie Faye', formation_nom: 'Ancienne formation (hors fenêtre)' }],
      ['test-hist-autre', ago(1), '0', { statut: 'ouvert', commercial_name: 'Dethie Faye', formation_nom: 'Autre contact' }],
    ]
    for (const [id, at, cid, over] of hist) {
      await kv('SET', `email_track:${id}`, JSON.stringify({ ...base, contact_id: cid, kind: 'initial', sujet: `[TEST-SEED] historique ${id}`, sent_at: new Date(at).toISOString(), ...over }))
      await kv('ZADD', `idx:contact:${cid}`, at, id)
      ids.push(id)
    }
  }

  if (withRelances) {
    // Fiche de test Dethie Faye ; tous les identifiants Slack sont TEST_SLACK_USER_ID
    const slackId = required('TEST_SLACK_USER_ID')
    const today = iso.split('T')[0]
    const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`)
    const minus = (n: number) => new Date(now.getTime() - n * 86400000).toISOString().split('T')[0]
    const common = {
      ...base, ps_nom: 'Monsieur Dethie Faye', ps_titre: 'Monsieur', ps_lastname: 'Faye', ps_rpps: '',
      commercial_name: 'Dethie Faye', commercial_email: 'dethie@medere.fr', commercial_key: 'dethie@medere.fr',
      commercial_slack_id: slackId, commercial_hubspot_id: '176772849', kind: 'initial',
      formation_nom: 'Formation de test', formation_numero: '00000000000', opened_at: null, clicked_at: null,
    }
    const t = (n: number) => new Date(now.getTime() - n * 86400000).toISOString()
    const cases: [string, Record<string, unknown>, string | null][] = [
      ['test-rel-non-ouvert', { statut: 'délivré', sent_at: t(5), delivered_at: t(5) }, minus(2)],
      ['test-rel-ouvert', { statut: 'ouvert', sent_at: t(3), first_opened_at: t(3), opened_at: t(3) }, today],
      ['test-rel-clique', { statut: 'cliqué', sent_at: t(3), first_opened_at: t(3), opened_at: t(3), first_clicked_at: t(3), clicked_at: t(3) }, today],
      ['test-rel-bounce', { statut: 'bounce', sent_at: t(3), bounced_at: t(3) }, today],
      ['test-rel-plainte', { statut: 'plainte', sent_at: t(3), complained_at: t(3) }, today],
      ['test-rel-deja', { statut: 'ouvert', sent_at: t(3), first_opened_at: t(3), relance_id: 'test-rel-deja-relance' }, today],
      ['test-rel-sans-slack', { statut: 'délivré', sent_at: t(3), commercial_slack_id: '' }, today],
      // Auteur Zacharie (refus de relance pour un non-auteur) : jamais d'échéance, Slack de test
      ['test-rel-zacharie', { statut: 'ouvert', sent_at: t(3), first_opened_at: t(3), commercial_name: 'Zacharie Groch', commercial_email: 'zacharie@medere.fr', commercial_key: 'zacharie@medere.fr' }, null],
    ]
    for (const [id, over, due] of cases) {
      await kv('SET', `email_track:${id}`, JSON.stringify({ ...common, sujet: `[TEST-SEED] relance ${id.replace('test-rel-', '')}`, ...over }))
      await kv('SET', `email_body:${id}`, JSON.stringify({ corps: `Bonjour Monsieur Faye,\n\n[TEST-SEED] corps d'origine de ${id}.\nInscription : www.agencedpc.fr/professionnel/.\n\nDethie Faye` }), 'EX', 7 * 86400)
      await kv('ZADD', 'emails_index', Date.parse(String(over.sent_at)), id)
      if (due) await kv('ZADD', 'relances_due', dayMs(due), id)
      ids.push(id)
    }
    await kv('SET', 'relance:test-rel-legacy', JSON.stringify({
      commercial_slack_id: slackId, commercial_name: 'Dethie Faye', ps_nom: 'Monsieur Dethie Faye', ps_email: psEmail,
      ps_rpps: '', ps_hubspot_id: contactId, formation_nom: 'Formation de test', formation_numero: '00000000000',
      sujet: '[TEST-SEED] relance legacy', corps: 'x', sent_at: t(3), relance_at: today,
    }), 'EX', 2 * 86400)
    await kv('ZADD', 'relances_due', dayMs(today), 'legacy:relance:test-rel-legacy')
  }

  if (withPurge) {
    const slackId = required('TEST_SLACK_USER_ID')
    const cases: [string, Record<string, string>, string][] = [
      ['test-purge-zacharie', { commercial_name: 'Zacharie Groch' }, 'au PS de test (contact)'],
      ['test-purge-kaoufer-email', { commercial_name: 'Kaoufer Guercif', contact_id: '0' }, 'au PS de test (adresse seule)'],
      ['test-autre-ps-zacharie', { commercial_name: 'Zacharie Groch', ...OTHER_PS }, 'à un autre PS'],
      ['test-autre-ps-sarah', { commercial_name: 'Sarah Smadja', ...OTHER_PS }, 'à un autre PS'],
    ]
    for (const [id, over, label] of cases) {
      await kv('SET', `email_track:${id}`, JSON.stringify({
        ...base, ...over, sujet: `[TEST-SEED] envoi ${label} par ${over.commercial_name}`, statut: 'envoyé',
        sent_at: sentAt, opened_at: null, clicked_at: null,
      }))
      await kv('ZADD', 'emails_index', Date.parse(sentAt), id)
      ids.push(id)
    }
    const relance = { commercial_slack_id: slackId, commercial_name: 'Zacharie Groch', formation_nom: 'Formation de test', formation_numero: '00000000000', corps: 'x', relance_at: iso.split('T')[0], sent_at: sentAt }
    await kv('SET', 'relance:test-purge-zacharie', JSON.stringify({ ...relance, ps_nom: 'Test', ps_email: psEmail, ps_hubspot_id: contactId, ps_rpps: '', sujet: '[TEST-SEED] relance PS de test' }), 'EX', 2 * 86400)
    await kv('SET', 'relance:test-autre-ps', JSON.stringify({ ...relance, ps_nom: OTHER_PS.ps_nom, ps_email: OTHER_PS.ps_email, ps_hubspot_id: OTHER_PS.contact_id, ps_rpps: '', sujet: '[TEST-SEED] relance autre PS' }), 'EX', 2 * 86400)
  }

  const created = [...ids.map((id) => `email_track:${id}`), `emails_index (+${ids.length} membres)`]

  if (withRelance) {
    const slackId = required('TEST_SLACK_USER_ID')
    const relance = {
      commercial_slack_id: slackId, commercial_name: 'Commercial de test',
      ps_nom: '[TEST-SEED] PS de test', ps_email: psEmail, ps_rpps: '', ps_hubspot_id: contactId,
      formation_nom: 'Formation de test', formation_numero: '00000000000', corps: '[TEST-SEED] corps du mail',
      relance_at: iso.split('T')[0],
    }
    // Comme /api/send avant v2 : écrite quelques secondes après l'envoi → rattachable à test-seed-envoye
    await kv('SET', RELANCE_KEYS[0], JSON.stringify({
      ...relance, sujet: envoyeSujet, sent_at: new Date(Date.parse(sentAt) + 2000).toISOString(),
    }), 'EX', 2 * 86400)
    await kv('SET', RELANCE_KEYS[1], JSON.stringify({
      ...relance, sujet: '[TEST-SEED] relance orpheline', sent_at: new Date(now.getTime() - 3 * 86400000).toISOString(),
    }), 'EX', 2 * 86400)
    created.push(...RELANCE_KEYS.map((k) => `${k} (expire dans 48 h)`))
  }

  console.log('Données de test créées :')
  for (const k of created) console.log(`  - ${k}`)
  console.log('\nWebhooks signés : node scripts/seed-test.ts webhook opened test-seed-envoye')
}

async function webhook(kind: string, emailId: string, args: string[]): Promise<void> {
  if (!WEBHOOK_TYPES.includes(kind) || !emailId) {
    console.error(`Usage : webhook <${WEBHOOK_TYPES.join('|')}> <email_id> [--created-at=<iso>] [--message-id=<id>]`)
    process.exit(1)
  }
  // --svix-id=<suffixe> : rejouer exactement le même événement (test du dédoublonnage)
  const fixedId = option(args, 'svix-id')
  const msgId = fixedId ? `${WEBHOOK_PREFIX}${fixedId}` : `${WEBHOOK_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const type = `email.${kind}`
  const createdAt = option(args, 'created-at') || new Date().toISOString()
  const messageId = option(args, 'message-id')
  // Clic : objet click comme Resend (lien, heure réelle du clic, navigateur, IP fictive)
  const click = kind === 'clicked' && !args.includes('--no-click')
    ? {
        click: {
          ipAddress: '192.0.2.1',
          link: option(args, 'link') ?? 'https://www.agencedpc.fr/professionnel/',
          timestamp: option(args, 'click-at') || createdAt,
          userAgent: option(args, 'ua') ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
        },
      }
    : {}
  const payload = JSON.stringify({
    type,
    created_at: createdAt,
    data: {
      email_id: emailId, created_at: createdAt, to: [env.TEST_PS_EMAIL || ''], subject: 'test',
      ...(messageId ? { message_id: messageId } : {}),
      ...click,
    },
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
    ...SEED_IDS.flatMap((id) => [`email_track:${id}`, `email_body:${id}`, `email_clicks:${id}`, `hubspot_note:${id}:opened`, `hubspot_note:${id}:clicked`]),
    ...RELANCE_KEYS,
    ...(await scan(`webhook_event:${WEBHOOK_PREFIX}*`)),
  ]
  let deleted = 0
  for (const k of keys) deleted += Number(await kv('DEL', k))
  // Index du schéma v2 : seuls les membres de test sont retirés
  const indexes = [
    'emails_index',
    'relances_due',
    `idx:contact:${required('TEST_HUBSPOT_CONTACT_ID')}`,
    `idx:contact:${OTHER_PS.contact_id}`,
    'idx:contact:0',
    ...SEED_COMMERCIAL_KEYS.map((k) => `idx:commercial:${k}`),
  ]
  let removed = 0
  for (const idx of indexes) {
    removed += Number(await kv('ZREM', idx, ...SEED_IDS, ...RELANCE_KEYS.map((k) => `legacy:${k}`)))
  }
  console.log(`${deleted} clé(s) supprimée(s), ${removed} membre(s) retiré(s) des index.`)
  console.log("Non retirés : compteurs stats:day:* et meta:commerciaux (restaurer l'export de début de session).")
  console.log('Les Notes HubSpot éventuellement créées sur le contact de test sont à supprimer à part (voir docs/TESTS.md).')
}

// Garde-fou Slack : aucune valeur de la base de test ne doit contenir un identifiant
// Slack (U… ou W…) autre que TEST_SLACK_USER_ID. À lancer avant tout test qui peut envoyer un DM.
async function checkSlack(): Promise<void> {
  const allowed = required('TEST_SLACK_USER_ID')
  const keys = await scan('*')
  const offenders: string[] = []
  for (const key of keys) {
    const type = String(await kv('TYPE', key))
    const value =
      type === 'string' ? await kv('GET', key)
      : type === 'hash' ? await kv('HGETALL', key)
      : type === 'zset' ? await kv('ZRANGE', key, 0, -1)
      : type === 'set' ? await kv('SMEMBERS', key)
      : type === 'list' ? await kv('LRANGE', key, 0, -1)
      : null
    const ids = (JSON.stringify(value).match(/\b[UW][A-Z0-9]{8,11}\b/g) || []).filter((id) => id !== allowed)
    if (ids.length) offenders.push(`${key} : ${Array.from(new Set(ids)).join(', ')}`)
  }
  if (offenders.length) {
    console.error(`REFUS : ${offenders.length} clé(s) contiennent un identifiant Slack autre que ${allowed} :`)
    for (const o of offenders) console.error(`  - ${o}`)
    process.exit(1)
  }
  console.log(`OK : ${keys.length} clé(s) vérifiée(s), aucun identifiant Slack autre que ${allowed}.`)
}

async function main(): Promise<void> {
  assertTestKv()
  const [cmd = 'seed', ...args] = process.argv.slice(2)
  if (cmd === 'seed') return seed(args.includes('--relance'), args.includes('--names'), args.includes('--clicks'), args.includes('--purge'), args.includes('--relances'), args.includes('--historique'))
  if (cmd === 'webhook') return webhook(args[0], args[1], args.slice(2))
  if (cmd === 'clean') return clean()
  if (cmd === 'check-slack') return checkSlack()
  console.error(`Commande inconnue : ${cmd} (seed | webhook | clean | check-slack)`)
  process.exit(1)
}

main().catch((e: unknown) => {
  console.error('ERREUR', e instanceof Error ? e.message : e)
  process.exit(1)
})
