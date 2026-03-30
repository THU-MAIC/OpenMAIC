import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

const PUBLIC_PATHS = ['/', '/login', '/register', '/api/auth', '/api/health', '/api/server-providers'];

export async function middleware(req: NextRequest) {
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

  const token = await getToken({ req, secret: process.env.AUTH_SECRET });
  const isAuth = !!token;

  // Redirect unauthenticated users to login
  if (!isAuth) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
