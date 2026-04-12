import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // Whitelist: access-code endpoints, health check
  if (pathname.startsWith('/api/access-code/') || pathname === '/api/health') {
    return NextResponse.next();
  }

  // Check cookie
  const cookie = request.cookies.get('openmaic_access');
  if (cookie) {
    return NextResponse.next();
  }

  // API requests without cookie → 401
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { success: false, error: 'Access code required' },
      { status: 401 },
    );
  }

  // Page requests → let through, frontend shows modal
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logos/).*)'],
};
