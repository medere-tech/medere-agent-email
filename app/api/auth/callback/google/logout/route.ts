import { NextRequest, NextResponse } from 'next/server'
import { deleteSession } from '@/lib/auth'

export async function GET(req: NextRequest) {
  await deleteSession()
  return NextResponse.redirect(new URL('/login', req.url))
}