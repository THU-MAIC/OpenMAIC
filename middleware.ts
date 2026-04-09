import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth/auth.config';

/**
 * Route protection middleware.
 *
 * Uses the edge-safe auth config (no Prisma/bcrypt). Full auth (with DB) is
 * loaded only in server routes via @/lib/auth/auth.
 *
 * Strategy: everything is protected by default except a small set of public
 * paths (auth pages, public APIs, health checks, etc.).
 */
const PUBLIC_PATHS = [
  '/auth',
  '/api/auth',
  '/api/lti', // LTI launches are signed externally
];

// Admin-only paths: require session.user.role === 'ADMIN'
const ADMIN_PATHS = ['/admin', '/api/admin'];

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (isPublic) return NextResponse.next();

  if (!req.auth) {
    const url = new URL('/auth/signin', req.url);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  const isAdminPath = ADMIN_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
  if (isAdminPath && req.auth.user?.role !== 'ADMIN') {
    return NextResponse.redirect(new URL('/', req.url));
  }

  return NextResponse.next();
});

export const config = {
  // Match everything except static assets and Next.js internals
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp)$).*)'],
};
