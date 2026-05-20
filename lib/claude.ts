import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

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

export async function generateMail(params: GenerateMailParams): Promise<{ sujet: string; corps: string }> {
  const { commercial, formation, sessions, ps, formationsLiees } = params

  const sessionsText = sessions
    .map((s) => {
      const parts = [`Session ${s.numero}`]
      if (s.temps_lisible) parts.push(`- ${s.temps_lisible}`)
      else if (s.date_cv1) parts.push(`- ${formatDate(s.date_cv1)}`)
      if (s.date_cv2) parts.push(`/ 2ème soirée : ${formatDate(s.date_cv2)}`)
      return parts.join(' ')
    })
    .join('\n')

  const upsellText =
    formationsLiees.length > 0
      ? `\n\nJ'en profite également pour vous partager d'autres formations susceptibles de vous intéresser, dès que vous aurez terminé cette formation :\n${formationsLiees.map((f) => {
          const ligne1 = `• ${f.nom} (${f.format})${f.prochaineSession ? ` - prochaine session disponible le ${f.prochaineSession}` : ''}`
          const ligne2 = f.url_webflow ? `  → ${f.url_webflow}` : ''
          return ligne2 ? `${ligne1}\n${ligne2}` : ligne1
        }).join('\n')}`
      : ''

  const prompt = `Tu es un assistant commercial pour Médéré, organisme de formation médicale DPC.
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

INSTRUCTIONS DPC À INCLURE :
1. Se rendre sur www.agencedpc.fr/professionnel/
2. Cliquer sur "S'identifier" (identifiant = adresse mail DPC, ou "mot de passe oublié" si besoin)
3. Aller dans "Actions DPC" > "Rechercher une action/S'inscrire"
4. Entrer le numéro de l'action DPC : ${formation.numero}
5. Dans "Détail" > "Liste sessions", choisir la session souhaitée
6. Cliquer sur "S'inscrire"

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
- Instructions DPC claires, numérotées
- Une phrase sur la prise en charge ANDPC
- Invitation à revenir vers le commercial
- Signature complète
- N'oublie pas de dire Bonjour,
- Les formations en classe viruelle ont lieu en soirée à partir de 19h00
- Si tu dois utiliser des tirets, utilise des tirets courts (-) et n'utilise jamais de tirets longs


Réponds UNIQUEMENT avec un JSON valide dans ce format exact :
{
  "sujet": "...",
  "corps": "..."
}
Le corps doit être en texte brut (pas de HTML), avec des retours à la ligne normaux.`

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
  
  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Claude did not return valid JSON')
  
  const result = JSON.parse(jsonMatch[0])
  return { sujet: result.sujet, corps: result.corps }
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date(dateStr))
  } catch {
    return dateStr
  }
}