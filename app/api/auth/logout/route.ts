import { NextRequest, NextResponse } from 'next/server'
import { deleteSession } from '@/lib/auth'

// POST uniquement : un simple lien (GET) ne doit pas pouvoir déconnecter l'utilisateur.
// 303 → le navigateur suit la redirection en GET vers /login.
export async function POST(req: NextRequest) {
  await deleteSession()
  return NextResponse.redirect(new URL('/login', req.url), 303)
}
