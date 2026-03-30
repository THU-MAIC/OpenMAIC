import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/auth.config';

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = ['/', '/login', '/register', '/api/auth', '/api/health', '/api/server-providers'];

export default auth(function middleware(req) {
  const { pathname } = req.nextUrl;

  // Allow public paths, static assets, and Next.js internals
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/')) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.match(/\.(ico|png|jpg|svg|woff2?)$/)
  ) {
    return NextResponse.next();
  }

  // Allow all API routes except /api/classrooms and /api/classroom (which need auth)
  if (
    pathname.startsWith('/api/') &&
    !pathname.startsWith('/api/classrooms') &&
    !pathname.startsWith('/api/classroom')
  ) {
    return NextResponse.next();
  }

  const isAuth = !!req.auth;

  // Redirect unauthenticated users to login
  if (!isAuth) {
    // Use the public-facing host (tunnel or localhost) so callbackUrl is correct
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    const proto = req.headers.get('x-forwarded-proto') || 'http';
    const base = host ? `${proto}://${host}` : req.nextUrl.origin;
    const loginUrl = new URL('/login', base);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
