import { auth } from '@/lib/auth/auth';
import { NextResponse } from 'next/server';

// Routes that are always public (no auth required)
const PUBLIC_ROUTES = [
  '/auth/signin',
  '/auth/setup',
  '/auth/consent',
  '/api/auth',
  '/api/setup',
  '/api/health',
  '/api/user/consent',
];

// Routes only accessible by admins
const ADMIN_ROUTES = ['/admin'];

export default auth(async (req) => {
  const session = req.auth;
  const pathname = req.nextUrl.pathname;

  // Always allow public routes and static assets
  if (
    PUBLIC_ROUTES.some((r) => pathname.startsWith(r)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/avatars') ||
    pathname.startsWith('/logos') ||
    pathname.startsWith('/favicon')
  ) {
    return NextResponse.next();
  }

  // Redirect unauthenticated users to sign-in
  if (!session?.user) {
    const signInUrl = new URL('/auth/signin', req.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  const { role, isActive, consentGiven } = session.user;

  // Inactive accounts cannot proceed
  if (!isActive) {
    return NextResponse.redirect(new URL('/auth/signin?error=AccountDisabled', req.url));
  }

  // PDPA: require consent before accessing any app content
  if (!consentGiven && !pathname.startsWith('/auth/consent')) {
    return NextResponse.redirect(new URL('/auth/consent', req.url));
  }

  // Admin users should land in admin panel by default.
  if (role === 'ADMIN' && pathname === '/') {
    return NextResponse.redirect(new URL('/admin', req.url));
  }

  // Admin-only routes
  if (ADMIN_ROUTES.some((r) => pathname.startsWith(r))) {
    if (role !== 'ADMIN') {
      return NextResponse.redirect(new URL('/', req.url));
    }
  }

  // Classroom access: only authorized users can enter classroom routes.
  const classroomMatch = pathname.match(/^\/classroom\/([^/]+)/);
  if (classroomMatch) {
    const classroomId = classroomMatch[1];
    // Check via API route to avoid importing Prisma in proxy logic
    const checkUrl = new URL(`/api/classroom-access/${classroomId}`, req.url);
    const checkRes = await fetch(checkUrl, {
      headers: { cookie: req.headers.get('cookie') ?? '' },
    });
    if (!checkRes.ok) {
      return NextResponse.redirect(new URL('/?error=AccessDenied', req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Match everything except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};