import { NextRequest, NextResponse } from 'next/server'
import { createSession } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error || !code) {
    return NextResponse.redirect(new URL('/login?error=access_denied', req.url))
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
      return NextResponse.redirect(new URL('/login?error=unauthorized_domain', req.url))
    }

    // Créer la session
    await createSession({
      email: user.email,
      name: user.name,
      picture: user.picture,
    })

    return NextResponse.redirect(new URL('/', req.url))
  } catch (e) {
    console.error('[AUTH] Callback error:', e)
    return NextResponse.redirect(new URL('/login?error=server_error', req.url))
  }
}