import { NextResponse, type NextRequest } from 'next/server';

const defaultProtectedHosts = ['study-api.papertok.ai'];

function protectedHosts(): string[] {
  const raw = process.env.STUDY_API_PUBLIC_HOSTS?.trim();
  if (!raw) {
    return defaultProtectedHosts;
  }
  return raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, '');
}

function isProtectedPublicHost(request: NextRequest): boolean {
  const host = normalizeHost(request.headers.get('host') || '');
  if (!host || host === '127.0.0.1' || host === 'localhost') {
    return false;
  }
  return protectedHosts().includes(host);
}

function extractBearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization')?.trim() || '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  const token = header.slice(7).trim();
  return token || null;
}

export function proxy(request: NextRequest) {
  if (!isProtectedPublicHost(request)) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (!pathname.startsWith('/api/')) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const expected = process.env.STUDY_API_BEARER_TOKEN?.trim();
  const provided = extractBearerToken(request);

  if (!expected || !provided) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: 'Missing bearer token',
      },
      { status: 401 },
    );
  }

  if (provided !== expected) {
    return NextResponse.json(
      {
        success: false,
        errorCode: 'INVALID_REQUEST',
        error: 'Invalid bearer token',
      },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next).*)'],
};
