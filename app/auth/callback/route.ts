import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { cookies } from 'next/headers';

/**
 * Build the post-OAuth redirect base URL. In production behind a reverse proxy
 * (e.g. Vercel), `x-forwarded-host` matches the URL users see; `request.url`
 * origin alone can misalign with Set-Cookie scope and break sessions.
 *
 * Prod verification (DevTools → Network): on GET `/auth/callback?code=…` check
 * Response `Set-Cookie` for `sb-*`; on the next navigation check Request `Cookie`.
 * Supabase: Site URL + Additional Redirect URLs must include this app’s exact
 * `https://<host>/auth/callback`; hosting env must match the same Supabase project
 * (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). Keep one
 * canonical host (www vs apex) or allowlist both callback URLs.
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');

  let next = searchParams.get('next') ?? '/';
  if (!next.startsWith('/') || next.startsWith('//')) {
    next = '/';
  }

  if (code) {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(buildPostAuthRedirectUrl(request, next));
    }
  }

  return NextResponse.redirect(
    buildPostAuthRedirectUrl(request, '/auth/login?error=auth_failed'),
  );
}
