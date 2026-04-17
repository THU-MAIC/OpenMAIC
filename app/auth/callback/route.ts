import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

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
  const { origin } = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');

  // #region agent log
  fetch('http://127.0.0.1:7806/ingest/f81b7429-4b05-466d-99c3-1456ca063132', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9d754c' },
    body: JSON.stringify({
      sessionId: '9d754c',
      location: 'app/auth/callback/route.ts:GET:entry',
      message: 'OAuth callback request',
      data: {
        hypothesisId: 'H3',
        hasCode: Boolean(code),
        next,
        origin,
        forwardedHost,
        forwardedProto,
        nodeEnv: process.env.NODE_ENV,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  if (code && supabaseUrl && supabaseKey) {
    const target = buildPostAuthRedirectUrl(request, next);
    const response = noStoreRedirect(target);

    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
          if (headers) {
            for (const [key, value] of Object.entries(headers)) {
              if (typeof value === 'string') {
                response.headers.set(key, value);
              }
            }
          }
        },
      },
    });

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    // #region agent log
    fetch('http://127.0.0.1:7806/ingest/f81b7429-4b05-466d-99c3-1456ca063132', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9d754c' },
      body: JSON.stringify({
        sessionId: '9d754c',
        location: 'app/auth/callback/route.ts:GET:exchange',
        message: 'exchangeCodeForSession finished',
        data: {
          hypothesisId: 'H1',
          ok: !error,
          errName: error?.name ?? null,
          errMessage: error?.message ?? null,
          runId: 'post-fix',
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    if (!error) {
      // #region agent log
      fetch('http://127.0.0.1:7806/ingest/f81b7429-4b05-466d-99c3-1456ca063132', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9d754c' },
        body: JSON.stringify({
          sessionId: '9d754c',
          location: 'app/auth/callback/route.ts:GET:successRedirect',
          message: 'Redirecting after successful exchange',
          data: {
            hypothesisId: 'H2',
            redirectTarget: target,
            forwardedHost,
            origin,
            runId: 'post-fix',
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      return response;
    }
  }

  // #region agent log
  fetch('http://127.0.0.1:7806/ingest/f81b7429-4b05-466d-99c3-1456ca063132', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '9d754c' },
    body: JSON.stringify({
      sessionId: '9d754c',
      location: 'app/auth/callback/route.ts:GET:failureRedirect',
      message: 'OAuth callback falling back to login',
      data: { hypothesisId: 'H1', reason: code ? 'exchange_failed' : 'no_code' },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  return noStoreRedirect(
    buildPostAuthRedirectUrl(request, '/auth/login?error=auth_failed'),
  );
}
