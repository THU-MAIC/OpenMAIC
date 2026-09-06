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
  for (let hop = 0; ; hop++) {
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });
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

    currentUrl = nextUrl;
  }
}
