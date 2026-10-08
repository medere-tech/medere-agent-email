import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'

const COOKIE_NAME = 'medere_session'

// Cookie du paramètre `state` OAuth (posé par /api/auth/login, vérifié par le callback)
export const OAUTH_STATE_COOKIE = 'medere_oauth_state'
export const OAUTH_STATE_PATH = '/api/auth'

// Lu à chaque appel : sans NEXTAUTH_SECRET, on lève une erreur explicite au lieu
// de signer/vérifier les sessions avec une clé vide.
function getSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error('NEXTAUTH_SECRET manquant')
  return new TextEncoder().encode(secret)
}
const SESSION_DURATION = 60 * 60 * 24 * 7 // 7 jours (JWT et maxAge du cookie)

export interface Session {
  email: string
  name: string
  picture?: string
}

export async function createSession(session: Session) {
  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION}s`)
    .sign(getSecret())

  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_DURATION,
    path: '/',
  })
}

export async function getSession(): Promise<Session | null> {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    if (!token) return null
    const { payload } = await jwtVerify(token, getSecret())
    return payload as unknown as Session
  } catch {
    return null
  }
}

export async function deleteSession() {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
}