// Démarrage du serveur (Next.js) : préchauffe les données Airtable (fiches, formations, sessions)
// pour qu'aucun utilisateur n'attende Airtable, même juste après un redémarrage. Sur un serveur qui
// tourne en continu, rafraîchissement chaque minute (une instance Vercel en sommeil ne l'exécute
// pas : la première requête au réveil déclenche alors le rafraîchissement en arrière-plan).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { warmAirtableCaches } = await import('@/lib/airtable')
  const warm = () => warmAirtableCaches().catch((e: any) => console.error('[AIRTABLE] Préchauffage impossible :', e?.message))
  warm()
  const timer = setInterval(warm, 60_000)
  timer.unref?.()
}
