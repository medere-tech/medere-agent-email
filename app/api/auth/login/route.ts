import { NextResponse } from 'next/server'
import { OAUTH_STATE_COOKIE, OAUTH_STATE_PATH } from '@/lib/auth'

// Démarre la connexion Google : génère un `state` aléatoire, le garde dans un cookie httpOnly
// (10 minutes, limité aux routes /api/auth) et le transmet à Google. Le callback refuse toute
// réponse dont le `state` ne correspond pas (protection contre la connexion forcée / login CSRF).
// Route handler et non page : un Server Component ne peut pas écrire de cookie en Next 14.
// force-dynamic : sans lui, Next rendrait ce GET au build et servirait le même `state` à tous.
export const dynamic = 'force-dynamic'

export async function GET() {
  const state = crypto.randomUUID()
  const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  googleAuthUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID!)
  googleAuthUrl.searchParams.set('redirect_uri', `${process.env.NEXTAUTH_URL}/api/auth/callback/google`)
  googleAuthUrl.searchParams.set('response_type', 'code')
  googleAuthUrl.searchParams.set('scope', 'openid email profile')
  googleAuthUrl.searchParams.set('hd', 'medere.fr')
  googleAuthUrl.searchParams.set('prompt', 'select_account')
  googleAuthUrl.searchParams.set('state', state)

  const response = NextResponse.redirect(googleAuthUrl.toString())
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: OAUTH_STATE_PATH,
  })
  return response
}
