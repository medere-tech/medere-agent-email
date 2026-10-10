import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const COOKIE_NAME = 'medere_session'

const PUBLIC_PATHS = ['/login', '/api/auth', '/api/webhooks', '/api/cron']

export async function middleware(req: NextRequest) {
  // Protection contre CVE-2025-29927
  if (req.headers.get('x-middleware-subrequest')) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  const { pathname } = req.nextUrl

  // Laisser passer les routes publiques
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Sans secret, aucune session ne peut être vérifiée : échec explicite plutôt
  // qu'une vérification avec une clé vide
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    console.error('[AUTH] NEXTAUTH_SECRET manquant — accès refusé à', pathname)
    return NextResponse.json({ error: 'Service momentanément indisponible. Préviens Déthié.' }, { status: 500 })
  }

  // Vérifier le cookie de session
  const token = req.cookies.get(COOKIE_NAME)?.value

  if (!token) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  try {
    await jwtVerify(token, new TextEncoder().encode(secret))
    return NextResponse.next()
  } catch {
    // Token invalide ou expiré
    const response = NextResponse.redirect(new URL('/login', req.url))
    response.cookies.delete(COOKIE_NAME)
    return response
  }
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}