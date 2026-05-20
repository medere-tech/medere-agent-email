import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const SECRET = new TextEncoder().encode(process.env.NEXTAUTH_SECRET!)
const COOKIE_NAME = 'medere_session'

const PUBLIC_PATHS = ['/login', '/api/auth']

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

  // Vérifier le cookie de session
  const token = req.cookies.get(COOKIE_NAME)?.value

  if (!token) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  try {
    await jwtVerify(token, SECRET)
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