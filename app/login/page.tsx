import { redirect } from 'next/navigation'
import React from 'react'
import { getSession } from '@/lib/auth'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string }
}) {
  const session = await getSession()
  if (session) redirect('/')

  const errorMessages: Record<string, string> = {
    access_denied: 'Accès refusé.',
    unauthorized_domain: 'Seuls les comptes @medere.fr sont autorisés.',
    server_error: 'Une erreur est survenue. Réessaie.',
  }

  const errorMsg = searchParams.error ? errorMessages[searchParams.error] : null

  const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  googleAuthUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID!)
  googleAuthUrl.searchParams.set('redirect_uri', `${process.env.NEXTAUTH_URL}/api/auth/callback/google`)
  googleAuthUrl.searchParams.set('response_type', 'code')
  googleAuthUrl.searchParams.set('scope', 'openid email profile')
  googleAuthUrl.searchParams.set('hd', 'medere.fr')
  googleAuthUrl.searchParams.set('prompt', 'select_account')

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="flex items-center justify-center gap-2 mb-3">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect x="2" y="3" width="8" height="18" rx="4" fill="#111111"/>
              <rect x="14" y="3" width="8" height="18" rx="4" fill="#111111"/>
            </svg>
            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Médéré</span>
          </div>
          <h1 className="text-xl font-semibold text-zinc-900">Agent Mail DPC</h1>
          <p className="text-sm text-zinc-500 mt-1">Connecte-toi avec ton compte Médéré</p>
        </div>

        <div className="bg-white border border-zinc-200 rounded-xl shadow-sm p-6">
          {errorMsg && (
            <div className="mb-4 p-3 bg-zinc-50 border border-zinc-200 rounded-lg text-sm text-zinc-700 flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 2L14.5 13.5H1.5L8 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M8 7V9.5M8 11.5V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              {errorMsg}
            </div>
          )}

          
            <a href={googleAuthUrl.toString()}
            className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-zinc-200 rounded-lg text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Se connecter avec Google
          </a>
        </div>

        <div className="mt-4 text-center text-xs text-zinc-400">
          Réservé aux équipes Médéré · Compte @medere.fr requis
        </div>
      </div>
    </div>
  )
}