/**
 * fetch() replacement that re-validates every redirect hop.
 *
 * The origin of an outbound request is checked once (by the caller, through
 * `validateUrlForSSRF`) and then handed to Node's default fetch, which follows
 * redirects on its own without ever re-checking the `Location` target. A host
 * that resolves publicly can therefore answer `302 Location:
 * http://<private-address>/...` and pull the request onto an internal network.
 *
 * This wrapper fetches with `redirect: 'manual'`, resolves each `Location`
 * against the current URL, re-runs `validateUrlForSSRF` on the resolved
 * target, and only then follows — mirroring the per-hop loop used by
 * `app/api/proxy-media/route.ts` and the agent-runtime media downloads. Hops
 * are bounded (5, matching those implementations). A rejected hop fails
 * loudly with the guard's own message; the 3xx is never handed back as if it
 * were a real response, and there is no unvalidated fallback.
 */
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

export const MAX_REDIRECT_HOPS = 5;

/**
 * Request headers that carry provider credentials and must never cross an
 * origin boundary when a redirect is followed manually. These are the header
 * spellings the provider layer attaches to outbound calls: `authorization`
 * (Bearer tokens from the OpenAI/Anthropic/Azure SDKs and the verify routes),
 * `api-key` (Azure), `x-api-key` (Anthropic) and `x-goog-api-key` (Google).
 * Matching is case-insensitive because HTTP header names are.
 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'api-key', 'x-api-key', 'x-goog-api-key']);

function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADERS.has(name.trim().toLowerCase());
}

/** Duck-typed Headers check so a Headers from any realm is recognized. */
function isHeadersInstance(value: unknown): value is Headers {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Headers).forEach === 'function' &&
    typeof (value as Headers).get === 'function' &&
    typeof (value as Headers).delete === 'function'
  );
}

function hasCredentialHeaders(headers: HeadersInit): boolean {
  if (isHeadersInstance(headers)) {
    for (const name of headers.keys()) {
      if (isCredentialHeader(name)) return true;
    }
    return false;
  }
  if (Array.isArray(headers)) {
    return headers.some(([name]) => isCredentialHeader(name));
  }
  return Object.keys(headers).some((name) => isCredentialHeader(name));
}

/**
 * Return a copy of `headers` without the credential headers, preserving the
 * original shape (`Headers` instance, string-pair array or plain object) so a
 * same-shape header block reaches the next hop.
 */
function stripCredentialHeaders(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!headers) return headers;
  if (isHeadersInstance(headers)) {
    const next = new Headers(headers);
    for (const name of CREDENTIAL_HEADERS) next.delete(name);
    return next;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([name]) => !isCredentialHeader(name));
  }
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isCredentialHeader(name)) next[name] = value;
  }
  return next;
}

/**
 * A request body that is a stream is consumed by the hop that is being sent,
 * so it cannot be replayed onto a redirect target. Anything that is neither a
 * string nor a static buffer-like value counts as unreplayable.
 */
function isStreamBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const candidate = body as {
    getReader?: unknown;
    pipe?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };
  return (
    typeof candidate.getReader === 'function' ||
    typeof candidate.pipe === 'function' ||
    typeof candidate[Symbol.asyncIterator] === 'function'
  );
}

function requestUrlString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Fetch `input`, following at most {@link MAX_REDIRECT_HOPS} redirects and
 * validating every hop target with {@link validateUrlForSSRF} before the next
 * request is made. Resolves with the first non-redirect response.
 */
export async function fetchWithRedirectValidation(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let currentUrl = requestUrlString(input);
  // init of the hop about to be issued; credential headers may be removed
  // from it before a cross-origin hop, never mutating the caller's init.
  let hopInit: RequestInit | undefined = init;
  for (let hop = 0; ; hop++) {
    const response = await fetch(currentUrl, { ...hopInit, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) throw new Error('Provider request redirected without a Location header');
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new Error(`Provider request exceeded ${MAX_REDIRECT_HOPS} redirects`);
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).href; // resolve relative redirects
    } catch {
      throw new Error('Provider request received an invalid redirect Location');
    }

    const ssrfError = await validateUrlForSSRF(nextUrl);
    if (ssrfError) throw new Error(ssrfError);

    // A streaming request body has been consumed by the request that just
    // answered with a redirect and cannot be replayed; fail loudly instead of
    // forwarding the next hop with an empty body.
    if (isStreamBody(hopInit?.body)) {
      throw new Error(
        'Provider request cannot follow a redirect: its streaming request body cannot be replayed',
      );
    }

    // Credentials are scoped to the origin that issued them. The platform
    // fetch drops Authorization itself on a cross-origin redirect; mirror that
    // here so provider keys are not forwarded to a different origin.
    // Same-origin hops keep their headers untouched.
    if (
      new URL(nextUrl).origin !== new URL(currentUrl).origin &&
      hopInit?.headers &&
      hasCredentialHeaders(hopInit.headers)
    ) {
      hopInit = { ...hopInit, headers: stripCredentialHeaders(hopInit.headers) };
    }

    currentUrl = nextUrl;
  }
}
