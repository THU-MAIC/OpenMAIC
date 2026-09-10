/**
 * One resolver for the base origin used to build classroom media serving
 * URLs (`mediaServingUrl` in `classroom-media-generation.ts`).
 *
 * Providers that hand back a hosted URL are stored directly and never touch
 * this resolver. It exists for the BYTE-FALLBACK branch only: byte-only
 * providers (raw audio/image data, no URL) are still written locally and
 * served through THIS app's own `/api/classroom-media/...` route, so those
 * serving URLs must be same-origin with the app instance the caller is
 * talking to, never with a different product's origin.
 *
 * ACCEPTED LIMITATION: URL-direct storage trades away the deletion-revocation
 * gate and the `Cache-Control: private` posture of /api/classroom-media; the
 * route REMAINS for legacy records (old courses still reference it), so its
 * tombstone veto stays in place.
 *
 * The old code fell back to `NEXT_PUBLIC_MAIN_SITE_ORIGIN` when no origin
 * was threaded; that env is the MAIN SITE origin (a different product), where
 * the classroom-media route does not exist and every request is rejected.
 * That env stays available for its other legitimate uses (auth redirects
 * etc.) — it must simply never be used to build media URLs.
 *
 * The agent RUNTIME persist paths (`classroom-media-bytes.ts`,
 * `generate-image.ts`, `generate-video.ts`) never call this resolver: they
 * run without an HTTP request and persist origin-independent RELATIVE
 * `/api/classroom-media/...` references instead, which stay valid no matter
 * which origin serves the app.
 */
import type { NextRequest } from 'next/server';

/**
 * Final fallback origin when nothing is threaded and no request exists.
 *
 * Deliberately a local dev origin, NOT `NEXT_PUBLIC_MAIN_SITE_ORIGIN`: in a
 * background/agent-runner context with no origin captured yet, the only
 * same-origin-safe guess is this app's own localhost. Production deployments
 * always thread a real origin (request-derived, or persisted at session
 * creation), so this fallback only ever fires in dev/tests. The agent
 * runtime's own persist paths do not use this resolver at all — they persist
 * relative references (see the module comment).
 */
export const LOCAL_MEDIA_ORIGIN = 'http://localhost:3000';

/** Strip trailing slashes so `${origin}/api/...` never double-slashes. */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '');
}

/**
 * Resolve the origin classroom media URLs should be built from.
 *
 * Precedence:
 *  1. an explicitly threaded origin (`deps.baseUrl`, a request-derived
 *     origin passed by API routes, or the session-creation origin the agent
 *     runner threads);
 *  2. the incoming request origin, when a request is available;
 *  3. {@link LOCAL_MEDIA_ORIGIN}.
 *
 * Never consults `NEXT_PUBLIC_MAIN_SITE_ORIGIN` — see the module comment.
 */
export function resolveMediaServingOrigin(
  threadedOrigin?: string | null,
  request?: NextRequest | null,
): string {
  if (threadedOrigin && threadedOrigin.trim()) return normalizeOrigin(threadedOrigin);
  if (request) return normalizeOrigin(requestOrigin(request));
  return LOCAL_MEDIA_ORIGIN;
}

/**
 * The origin this app instance is reachable at for the given request:
 * proxy-forwarded host when present, else the request URL's own origin.
 */
export function requestOrigin(req: NextRequest): string {
  const forwardedHost = req.headers.get('x-forwarded-host');
  if (forwardedHost) {
    return `${req.headers.get('x-forwarded-proto') || 'http'}://${forwardedHost}`;
  }
  return req.nextUrl.origin;
}
