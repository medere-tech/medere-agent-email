import { NextRequest, NextResponse } from 'next/server'
import { OAUTH_STATE_COOKIE, OAUTH_STATE_PATH, createSession } from '@/lib/auth'

// Redirection qui efface toujours le cookie du `state` (usage unique)
function redirectTo(path: string, req: NextRequest) {
  const response = NextResponse.redirect(new URL(path, req.url))
  response.cookies.set(OAUTH_STATE_COOKIE, '', { path: OAUTH_STATE_PATH, maxAge: 0 })
  return response
}

export async function GET(req: NextRequest) {
  if (!process.env.NEXTAUTH_SECRET) {
    console.error('[AUTH] NEXTAUTH_SECRET manquant — impossible de créer une session')
    return NextResponse.json({ error: 'Service momentanément indisponible. Préviens Déthié.' }, { status: 500 })
  }

  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error || !code) {
    return redirectTo('/login?error=access_denied', req)
  }

  // Le `state` renvoyé par Google doit être celui posé par /api/auth/login (cookie httpOnly)
  const state = searchParams.get('state')
  const expectedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value
  if (!state || !expectedState || state !== expectedState) {
    console.warn('[AUTH] Paramètre state absent ou invalide, connexion refusée')
    return redirectTo('/login?error=invalid_state', req)
  }

  try {
    const origin = new URL(req.url).origin

    // Échanger le code contre un token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${origin}/api/auth/callback/google`,
        grant_type: 'authorization_code',
      }),
    })

    const tokens = await tokenRes.json()
    if (!tokens.access_token) throw new Error('No access token')

    // Récupérer les infos de l'utilisateur
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const user = await userRes.json()

    // Vérifier le domaine @medere.fr
    if (!user.email?.endsWith('@medere.fr') || !user.verified_email) {
      return redirectTo('/login?error=unauthorized_domain', req)
    }

    // Créer la session
    await createSession({
      email: user.email,
      name: user.name,
      picture: user.picture,
    })

    return redirectTo('/', req)
  } catch (e) {
    console.error('[AUTH] Callback error:', e)
    return redirectTo('/login?error=server_error', req)
  }
}