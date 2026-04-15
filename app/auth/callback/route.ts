import { type NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';

function sanitizeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) {
    return '/';
  }
  return next;
}

/**
 * Build the post-OAuth redirect URL. Behind a reverse proxy (e.g. Vercel),
 * `request.url` origin can differ from the public host users see, which breaks
 * cookie scope alignment and redirects. Prefer `x-forwarded-host` in production.
 *
 * Supabase: Site URL + Additional Redirect URLs must include
 * `https://<your-host>/auth/callback` for each canonical host you use.
 */
function buildPostAuthRedirectUrl(request: NextRequest, pathWithSearch: string): string {
  const { origin } = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host');
  const isLocalEnv = process.env.NODE_ENV === 'development';

  if (isLocalEnv) {
    return `${origin}${pathWithSearch}`;
  }
  if (forwardedHost) {
    const proto = request.headers.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${forwardedHost}${pathWithSearch}`;
  }
  return `${origin}${pathWithSearch}`;
}

function noStoreRedirect(url: string | URL) {
  const response = NextResponse.redirect(url);
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, must-revalidate, max-age=0',
  );
  response.headers.set('Pragma', 'no-cache');
  return response;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = sanitizeNext(searchParams.get('next'));

  if (code) {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return noStoreRedirect(buildPostAuthRedirectUrl(request, next));
    }
  }

  return noStoreRedirect(
    buildPostAuthRedirectUrl(request, '/auth/login?error=auth_failed'),
  );
}
