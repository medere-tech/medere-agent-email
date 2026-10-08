// Schéma des données KV (Upstash Redis) : noms de clés, jours, scripts Lua atomiques.
// Aucun import et aucune syntaxe TypeScript non effaçable : ce fichier est importé
// tel quel par les scripts Node (scripts/migrate-kv.ts, exécuté sans compilation).
//
// Clés :
//   email_track:{id}          JSON de l'envoi (format historique + champs v2), sans TTL, purgé par le cron
//   email_body:{id}           JSON { corps } du mail, TTL EMAIL_BODY_TTL_DAYS
//   emails_index              sorted set des envois initiaux (score = date d'envoi en ms)
//   idx:commercial:{clé}      sorted set des envois (initiaux et relances) d'un commercial
//   idx:contact:{contactId}   sorted set des envois à un contact HubSpot
//   stats:day:{AAAA-MM-JJ}    hash des compteurs du jour d'envoi (heure de Paris), EXPIREAT jour + rétention
//   meta:commerciaux          hash clé commercial → nom affiché
//   relances_due              sorted set des relances J+3 (score = jour d'échéance 00:00 UTC en ms)
//   meta:schema_version       "2" une fois scripts/migrate-kv.ts passé
//
// Clé commercial : email en minuscules, ou "nom:{slug}" pour un ancien envoi dont le nom
// n'a pas pu être rattaché de façon sûre à un email.

export const KEYS = {
  track: (id: string) => `email_track:${id}`,
  body: (id: string) => `email_body:${id}`,
  sendResult: (id: string) => `send_result:${id}`,
  noteLock: (id: string, kind: 'opened' | 'clicked') => `hubspot_note:${id}:${kind}`,
  emailsIndex: 'emails_index',
  byCommercial: (key: string) => `idx:commercial:${key}`,
  byContact: (contactId: string) => `idx:contact:${contactId}`,
  statsDay: (day: string) => `stats:day:${day}`,
  commerciaux: 'meta:commerciaux',
  relancesDue: 'relances_due',
  schemaVersion: 'meta:schema_version',
}

export const SCHEMA_VERSION = '2'

// Compteurs journaliers. Les relances (lot 3) ont les mêmes champs préfixés par "relance_",
// hors des taux principaux. Chaque champ existe aussi en "{champ}|{clé commercial}".
export const STAT_FIELDS = ['sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'] as const

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function commercialKey(email: string | undefined, name: string | undefined): string {
  const e = (email || '').trim().toLowerCase()
  if (e) return e
  return `nom:${slugify(name || '') || 'inconnu'}`
}

// Jour calendaire (AAAA-MM-JJ) d'une date dans le fuseau donné
export function dayInTimezone(date: Date | string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(date))
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Début du jour (00:00 UTC) en ms : score des relances dues ce jour-là
export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

// Expiration (secondes Unix) d'un hash stats:day : fin du jour + rétention
export function statsExpireAt(day: string, retentionDays: number): number {
  return Math.floor(dayStartMs(addDays(day, retentionDays + 1)) / 1000)
}

// ─── Lua ──────────────────────────────────────────────────────────────────────
// Fonctions communes. Sur Upstash, cjson décode null en nil : une clé à null
// disparaîtrait à la réécriture ; encode() rajoute opened_at / clicked_at, lus
// par l'ancienne page /suivi.
const LUA_COMMON = `
local function isset(v) return v ~= nil and v ~= cjson.null and v ~= '' and v ~= false end

local RANK = { ['envoyé'] = 0, ['délivré'] = 1, ['ouvert'] = 2, ['cliqué'] = 3, ['bounce'] = 10, ['plainte'] = 11 }
local function promote(d, target)
  if RANK[target] > (RANK[d.statut] or 0) then d.statut = target end
end

-- Compte un fait (délivré, ouvert…) une seule fois par envoi, dans le hash du jour
-- d'envoi. Une entrée non migrée (v ~= 2) n'est pas comptée : la migration le fera.
local function count(d, statsKey, expireAt, field)
  if d.v ~= 2 or d['counted_' .. field] then return end
  d['counted_' .. field] = true
  local prefix = ''
  if d.kind == 'relance' then prefix = 'relance_' end
  redis.call('HINCRBY', statsKey, prefix .. field, 1)
  if isset(d.commercial_key) then
    redis.call('HINCRBY', statsKey, prefix .. field .. '|' .. d.commercial_key, 1)
  end
  redis.call('EXPIREAT', statsKey, expireAt)
end

local function encode(d)
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
  return json
end
`

// Création d'un envoi (NX) + index + compteur "sent" + corps + relance, en une fois.
// KEYS : 1 track, 2 emails_index, 3 idx:commercial, 4 idx:contact, 5 stats:day,
//        6 meta:commerciaux, 7 email_body, 8 relances_due
// ARGV : 1 entrée JSON, 2 score (ms), 3 id, 4 expireAt stats, 5 corps JSON ('' = aucun),
//        6 TTL corps (s), 7 score relance ('' = aucune), 8 nom commercial,
//        9 '1' = ajouter à emails_index, 10 '1' = contact connu
// Retour : 1 si créé, 0 si l'envoi existait déjà (rejeu idempotent)
export const SEND_SCRIPT = LUA_COMMON + `
if not redis.call('SET', KEYS[1], ARGV[1], 'NX') then return 0 end
local d = cjson.decode(ARGV[1])
local prefix = ''
if d.kind == 'relance' then prefix = 'relance_' end
redis.call('HINCRBY', KEYS[5], prefix .. 'sent', 1)
redis.call('HINCRBY', KEYS[5], prefix .. 'sent|' .. d.commercial_key, 1)
redis.call('EXPIREAT', KEYS[5], tonumber(ARGV[4]))
if ARGV[9] == '1' then redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3]) end
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
if ARGV[10] == '1' then redis.call('ZADD', KEYS[4], ARGV[2], ARGV[3]) end
if ARGV[8] ~= '' then redis.call('HSET', KEYS[6], d.commercial_key, ARGV[8]) end
if ARGV[5] ~= '' then redis.call('SET', KEYS[7], ARGV[5], 'EX', tonumber(ARGV[6])) end
if ARGV[7] ~= '' then redis.call('ZADD', KEYS[8], ARGV[7], ARGV[3]) end
return 1
`

// Événement webhook Resend appliqué de façon atomique à email_track + compteurs.
//   - statut monotone : envoyé < délivré < ouvert < cliqué ; bounce et plainte finaux prioritaires
//   - first_* écrits une seule fois ; last_opened_at, open_count, click_count mis à jour
//   - événement automatique (ARGV[3] = '1') : auto_* uniquement, ni statut ni compteur ni Note
//   - entrée antérieure aux first_* déjà ouverte/cliquée : date reprise, verrou de Note "legacy"
// KEYS : 1 track, 2 stats:day (jour d'envoi), 3 hubspot_note:{id}:opened, 4 hubspot_note:{id}:clicked
// ARGV : 1 delivered|bounced|complained|opened|clicked, 2 date ISO, 3 '1' si automatique,
//        4 expireAt stats, 5 message_id ('' = inconnu)
// Retour : { suivi (0|1), Note ouverture à créer (0|1), Note clic à créer (0|1), statut }
export const EVENT_SCRIPT = LUA_COMMON + `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 0, 0, ''} end
local d = cjson.decode(raw)
local kind, at, auto, expireAt = ARGV[1], ARGV[2], ARGV[3] == '1', tonumber(ARGV[4])
local noteOpen, noteClick = 0, 0

if ARGV[5] ~= '' and not isset(d.message_id) then d.message_id = ARGV[5] end

if kind == 'delivered' then
  if not isset(d.delivered_at) then d.delivered_at = at end
  count(d, KEYS[2], expireAt, 'delivered')
  promote(d, 'délivré')
elseif kind == 'bounced' then
  if not isset(d.bounced_at) then d.bounced_at = at end
  count(d, KEYS[2], expireAt, 'bounced')
  promote(d, 'bounce')
elseif kind == 'complained' then
  if not isset(d.complained_at) then d.complained_at = at end
  count(d, KEYS[2], expireAt, 'delivered')
  count(d, KEYS[2], expireAt, 'complained')
  promote(d, 'plainte')
elseif kind == 'opened' or kind == 'clicked' then
  local o = kind == 'opened'
  local p = o and 'opened' or 'clicked'
  local firstField, field, cntField = 'first_' .. p .. '_at', p .. '_at', o and 'open_count' or 'click_count'
  local lock = o and KEYS[3] or KEYS[4]
  -- une ouverture ou un clic, même automatique, prouve la livraison
  count(d, KEYS[2], expireAt, 'delivered')
  promote(d, 'délivré')
  if auto then
    local autoCnt = o and 'auto_open_count' or 'auto_click_count'
    d[autoCnt] = (tonumber(d[autoCnt]) or 0) + 1
    if not isset(d['first_auto_' .. p .. '_at']) then d['first_auto_' .. p .. '_at'] = at end
  else
    d[cntField] = (tonumber(d[cntField]) or 0) + 1
    if o then d.last_opened_at = at end
    if not isset(d[firstField]) then
      if isset(d[field]) then
        d[firstField] = d[field]
        redis.call('SET', lock, 'legacy')
      else
        d[firstField] = at
        d[field] = at
      end
    end
    -- un clic sans ouverture détectée (pixel bloqué) compte aussi comme ouverture
    count(d, KEYS[2], expireAt, 'opened')
    if not o then count(d, KEYS[2], expireAt, 'clicked') end
    promote(d, o and 'ouvert' or 'cliqué')
    if redis.call('SET', lock, at, 'NX') then
      if o then noteOpen = 1 else noteClick = 1 end
    end
  end
end

redis.call('SET', KEYS[1], encode(d))
return {1, noteOpen, noteClick, d.statut}
`

// Migration d'une entrée vers v2 (idempotent : une entrée déjà en v2 est ignorée).
// Complète les champs, ajoute ses contributions aux compteurs et aux index.
// KEYS : 1 track, 2 emails_index, 3 idx:commercial, 4 idx:contact, 5 stats:day,
//        6 meta:commerciaux, 7 hubspot_note:{id}:opened, 8 hubspot_note:{id}:clicked
// ARGV : 1 id, 2 score (ms), 3 clé commercial, 4 nom ('' = ne pas enregistrer dans meta),
//        5 expireAt stats, 6 jour d'envoi, 7 '1' = contact connu
// Retour : 1 si migrée, 0 sinon
export const MIGRATE_SCRIPT = LUA_COMMON + `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local d = cjson.decode(raw)
if d.v == 2 then return 0 end
d.v = 2
if not isset(d.kind) then d.kind = 'initial' end
d.sent_day = ARGV[6]
d.commercial_key = ARGV[3]
if string.find(ARGV[3], '@', 1, true) and not isset(d.commercial_email) then d.commercial_email = ARGV[3] end

if not isset(d.first_opened_at) and isset(d.opened_at) then
  d.first_opened_at = d.opened_at
  redis.call('SET', KEYS[7], 'legacy', 'NX')
end
if not isset(d.first_clicked_at) and isset(d.clicked_at) then
  d.first_clicked_at = d.clicked_at
  redis.call('SET', KEYS[8], 'legacy', 'NX')
end
if not isset(d.last_opened_at) and isset(d.opened_at) then d.last_opened_at = d.opened_at end
if d.open_count == nil then d.open_count = isset(d.first_opened_at) and 1 or 0 end
if d.click_count == nil then d.click_count = isset(d.first_clicked_at) and 1 or 0 end

local exp = tonumber(ARGV[5])
local opened = isset(d.first_opened_at) or isset(d.first_clicked_at)
local r = RANK[d.statut] or 0
count(d, KEYS[5], exp, 'sent')
if isset(d.delivered_at) or opened or isset(d.first_auto_opened_at) or isset(d.first_auto_clicked_at)
   or (r >= 1 and r <= 3) or d.statut == 'plainte' or isset(d.complained_at) then
  count(d, KEYS[5], exp, 'delivered')
end
if opened then count(d, KEYS[5], exp, 'opened') end
if isset(d.first_clicked_at) then count(d, KEYS[5], exp, 'clicked') end
if isset(d.bounced_at) or d.statut == 'bounce' then count(d, KEYS[5], exp, 'bounced') end
if isset(d.complained_at) or d.statut == 'plainte' then count(d, KEYS[5], exp, 'complained') end

if d.kind ~= 'relance' then redis.call('ZADD', KEYS[2], 'NX', ARGV[2], ARGV[1]) end
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
if ARGV[7] == '1' then redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1]) end
if ARGV[4] ~= '' then redis.call('HSET', KEYS[6], ARGV[3], ARGV[4]) end
redis.call('SET', KEYS[1], encode(d))
return 1
`

// Reprise d'une ancienne clé relance:{ts} rattachée à son envoi : champs manquants
// complétés, relance planifiée dans relances_due, corps sauvegardé, ancienne clé supprimée.
// KEYS : 1 track, 2 relances_due, 3 ancienne clé relance:*, 4 email_body
// ARGV : 1 id, 2 score échéance (ms), 3 champs JSON, 4 corps JSON ('' = aucun), 5 TTL corps (s, > 0),
//        6 jour d'échéance
// Retour : 1 si reprise, 0 si l'envoi n'existe pas
export const ATTACH_RELANCE_SCRIPT = LUA_COMMON + `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local d = cjson.decode(raw)
local f = cjson.decode(ARGV[3])
for k, v in pairs(f) do
  if not isset(d[k]) and isset(v) then d[k] = v end
end
if not isset(d.relance_due_day) then d.relance_due_day = ARGV[6] end
redis.call('SET', KEYS[1], encode(d))
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
if ARGV[4] ~= '' then redis.call('SET', KEYS[4], ARGV[4], 'NX', 'EX', tonumber(ARGV[5])) end
redis.call('DEL', KEYS[3])
return 1
`
