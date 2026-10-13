// Parcours d'inscription sur agencedpc.fr, source unique pour le mail initial, la relance rédigée
// et le brouillon de relance. Fonctions pures, sans import.
// Depuis le 15 septembre 2026, l'ANDPC impose l'authentification forte : à l'identification, le PS
// reçoit un code de sécurité par SMS sur le mobile renseigné dans son espace personnel.

export const SMS_STEP =
  "Saisissez le code de sécurité reçu par SMS sur votre téléphone mobile (authentification forte exigée par l'ANDPC depuis le 15 septembre 2026)."

export const SMS_TIP =
  "Si vous n'avez pas encore vérifié votre numéro de mobile dans votre espace personnel agencedpc.fr, faites-le avant de vous inscrire : c'est sur ce numéro que le code est envoyé."

// Les 7 étapes, dans l'ordre, au vouvoiement (telles qu'elles doivent apparaître au PS)
export function dpcSteps(numeroAction: string): string[] {
  return [
    'Rendez-vous sur www.agencedpc.fr/professionnel/',
    `Cliquez sur "S'identifier" (votre identifiant est votre adresse mail DPC ; en cas d'oubli, cliquez sur "mot de passe oublié")`,
    SMS_STEP,
    `Allez dans "Actions DPC" > "Rechercher une action/S'inscrire"`,
    `Entrez le numéro de l'action DPC : ${numeroAction || '(numéro de l\'action DPC)'}`,
    `Dans "Détail" > "Liste sessions", choisissez la session souhaitée`,
    `Cliquez sur "S'inscrire"`,
  ]
}

export function dpcStepsText(numeroAction: string): string {
  return dpcSteps(numeroAction).map((s, i) => `${i + 1}. ${s}`).join('\n')
}

// Libellés des sessions : lib/session-label.ts (calculés dans le code, jamais par le modèle)

// RGPD : aucun texte destiné à un PS ne mentionne ni ne laisse deviner le suivi des ouvertures et des clics
export const NO_TRACKING_RULE = `CONFIDENTIALITÉ (règle absolue) : ne mentionne jamais et ne laisse jamais deviner que l'ouverture du mail ou les clics sont suivis. Interdit notamment : « j'ai vu que », « vous avez pu prendre connaissance », « vous avez ouvert », « vous avez consulté », « vous avez lu », « vous n'avez pas eu le temps de lire », « vous avez cliqué », et toute formulation équivalente. Ne fais aucune supposition sur ce que le PS a fait ou non du premier mail.`
