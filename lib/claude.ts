import Anthropic from '@anthropic-ai/sdk'
import { REDACTION_MODEL } from '@/lib/config'
import { NO_TRACKING_RULE, SMS_STEP, SMS_TIP, dpcStepsText, sessionsText as formatSessions, type SessionForText } from '@/lib/dpc-steps'

// Clé lue à chaque appel (comme le jeton HubSpot) : un changement de clé est pris en compte sans redémarrage
let cached: { key: string; client: Anthropic } | null = null
function anthropic(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY || ''
  if (!cached || cached.key !== key) cached = { key, client: new Anthropic({ apiKey: key }) }
  return cached.client
}

export interface GenerateMailParams {
  commercial: { name: string; email: string; phone?: string }
  formation: { nom: string; numero: string; format: string }
  sessions: Array<{
    numero: string
    date_cv1: string
    date_cv2?: string
    date_debut: string
    temps_lisible: string
  }>
  ps: { titre: string; nom: string; prenom: string; specialite?: string }
  formationsLiees: Array<{ nom: string; format: string; prochaineSession?: string; url_webflow?: string }>
}

// Prompt du mail initial. Réponse attendue en texte : « Objet : … », une ligne vide, puis le mail
// (format lisible au fil de l'eau pour l'affichage progressif, voir lib/generated-mail.ts).
export function buildMailPrompt(params: GenerateMailParams): string {
  const { commercial, formation, sessions, ps, formationsLiees } = params

  const sessionsText = formatSessions(sessions)

  const upsellText =
    formationsLiees.length > 0
      ? `\n\nJ'en profite également pour vous partager d'autres formations susceptibles de vous intéresser, dès que vous aurez terminé cette formation :\n${formationsLiees.map((f) => {
          const ligne1 = `• ${f.nom} (${f.format})${f.prochaineSession ? ` - prochaine session disponible le ${f.prochaineSession}` : ''}`
          const ligne2 = f.url_webflow ? `  → ${f.url_webflow}` : ''
          return ligne2 ? `${ligne1}\n${ligne2}` : ligne1
        }).join('\n')}`
      : ''

  return `Tu es un assistant commercial pour Médéré, organisme de formation médicale DPC.
Tu dois rédiger un email professionnel, chaleureux et clair pour un professionnel de santé (PS) qui a manifesté son intérêt par téléphone.

CONTEXTE :
- Commercial : ${commercial.name} (${commercial.email})
- PS : ${ps.titre} ${ps.prenom} ${ps.nom}${ps.specialite ? ` - ${ps.specialite}` : ''}
- Formation souhaitée : "${formation.nom}"
- Numéro d'action DPC : ${formation.numero}
- Format : ${formation.format}
- Sessions disponibles :
${sessionsText}

OBJECTIF DU MAIL :
Aider le PS à finaliser son inscription sur agencedpc.fr avec les étapes précises. Être chaleureux, concis, et rassurant.

INSTRUCTIONS DPC À INCLURE (les 7 étapes, toutes, dans cet ordre exact, numérotées de 1 à 7) :
${dpcStepsText(formation.numero)}

L'étape 3 (code reçu par SMS) est obligatoire et se reprend mot pour mot : « ${SMS_STEP} »
Juste après les étapes, ajoute ce conseil en une phrase : « ${SMS_TIP} »

RAPPEL CLÉ : Les formations sont intégralement prises en charge par l'ANDPC.

SESSIONS À PROPOSER : Mentionne toutes les sessions listées ci-dessus avec leurs dates exactes.

UPSELL (en fin de mail, si pertinent) :${upsellText || ' Aucune formation complémentaire à mentionner.'}

SIGNATURE :
${commercial.name}
${commercial.email}
${commercial.phone || ''}

STYLE :
- Ton professionnel mais humain, pas robotique
- Phrase d'accroche qui rappelle l'appel du jour
- Instructions DPC claires, numérotées de 1 à 7 (parcours à jour avec le code SMS)
- Une phrase sur la prise en charge ANDPC
- Invitation à revenir vers le commercial
- Signature complète
- N'oublie pas de dire Bonjour,
- Les formations en classe viruelle ont lieu en soirée à partir de 19h00
- Si tu dois utiliser des tirets, utilise des tirets courts (-) et n'utilise jamais de tirets longs

${NO_TRACKING_RULE}


FORMAT DE RÉPONSE (obligatoire, rien avant ni après) :
Objet : <l'objet du mail, sur une seule ligne>

<le texte complet du mail>

Le texte est en texte brut (pas de HTML, pas de Markdown), avec des retours à la ligne normaux.`
}

// Rédaction du mail initial, transmise au fil de l'eau (morceaux de texte bruts)
export async function* streamMail(params: GenerateMailParams): AsyncGenerator<string> {
  const stream = await anthropic().messages.create({
    model: REDACTION_MODEL,
    max_tokens: 1500,
    stream: true,
    messages: [{ role: 'user', content: buildMailPrompt(params) }],
  })
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text
  }
}

export interface GenerateRelanceParams {
  commercial: { name: string; email: string; phone?: string }
  ps: { titre: string; nom: string }
  formationNom: string
  formationNumero: string
  sessions: SessionForText[]
}

// Relance d'un mail déjà envoyé. Le statut du premier mail (ouvert, cliqué…) n'est JAMAIS transmis :
// la relance est identique quel que soit le statut, et ne laisse pas deviner le suivi (RGPD).
// Elle se suffit à elle-même (formation, sessions, numéro DPC, 7 étapes, signature) : le premier
// mail n'est pas recopié (il peut contenir l'ancien parcours en 6 étapes).
export function buildRelancePrompt(params: GenerateRelanceParams): string {
  const { commercial, ps, formationNom, formationNumero, sessions } = params
  const sessionsBlock = sessions.length ? formatSessions(sessions) : 'Aucune session à citer (ne pas en inventer) : inviter le PS à choisir la session qui lui convient dans « Liste sessions ».'
  return `Tu es un assistant commercial pour Médéré, organisme de formation médicale DPC.
Rédige une RELANCE courte pour un professionnel de santé à qui le commercial a déjà envoyé les informations d'une formation : 2 à 4 lignes d'introduction neutre, les sessions disponibles, le parcours d'inscription à jour, puis la signature.

CONTEXTE :
- Commercial : ${commercial.name} (${commercial.email})
- PS : ${ps.titre} ${ps.nom}
- Formation : "${formationNom}"
- Numéro d'action DPC : ${formationNumero || 'inconnu'}
- Sessions disponibles :
${sessionsBlock}

INTRODUCTION : neutre, du type « Je me permets de revenir vers vous concernant la formation … ». Rappelle que la formation est intégralement prise en charge par l'ANDPC et propose ton aide pour l'inscription.

${NO_TRACKING_RULE}

PARCOURS D'INSCRIPTION À JOUR (obligatoire, avant la signature, les 7 étapes dans cet ordre exact, numérotées de 1 à 7) :
${dpcStepsText(formationNumero)}

L'étape 3 (code reçu par SMS) se reprend mot pour mot : « ${SMS_STEP} »
Juste après les étapes, ajoute ce conseil en une phrase : « ${SMS_TIP} »

STYLE :
- Commence par "Bonjour ${ps.titre} ${ps.nom}," (ou "Bonjour," si le nom manque)
- Ton professionnel, chaleureux, jamais insistant
- Termine par la signature, une information par ligne : ${[commercial.name, commercial.email, commercial.phone].filter(Boolean).join(' / ')}
- Ne recopie pas et ne cite pas le premier mail ; rien après la signature
- Tirets courts (-) uniquement, jamais de tirets longs
- Texte brut, sans HTML ni Markdown

Réponds UNIQUEMENT avec le texte complet de la relance.`
}

export async function generateRelance(params: GenerateRelanceParams): Promise<string> {
  const prompt = buildRelancePrompt(params)
  const msg = await anthropic().messages.create({
    model: REDACTION_MODEL,
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : ''
  if (!text) throw new Error('Relance vide')
  return text
}
