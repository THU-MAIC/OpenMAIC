/**
 * The HTTP side of claiming anonymous work: the checks and answers shared by
 * `POST /api/identity/claim`, the runtime contract's learner merge route, and
 * the automatic trigger (`OWNER_CLAIM_TRIGGER=auto`).
 */
import { getOwnerAuthenticator } from '@/lib/server/identity/registry';
import type { OwnerPrincipal } from '@/lib/server/identity/types';

import {
  claimPendingOwner,
  OwnerClaimError,
  type ClaimOwnerOptions,
  type ClaimOwnerResult,
  type OwnerClaimRefusal,
} from './owner-claims';

/**
 * Whether a claim request can only have come from this site's own pages.
 *
 * The claim is authorized by cookies (the account's and the anonymous one), so
 * it must not be something another site can make a browser send. Two
 * independent conditions, both required:
 *
 * - The body is declared `application/json`. An HTML form cannot send that
 *   content type, and a cross-site script can only send it after a CORS
 *   preflight, which this app does not grant.
 * - The browser's own provenance header agrees: `Sec-Fetch-Site` must be
 *   `same-origin` when present (every current browser sends it), and
 *   otherwise an `Origin`, when present, must name this host. A request with
 *   neither carries no browser metadata at all, so it did not come from a
 *   browser a third-party page controls.
 */
export function isSameOriginJsonRequest(request: Request): boolean {
  const contentType = (request.headers.get('content-type') ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') return false;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null) return site.trim().toLowerCase() === 'same-origin';
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const hosts = [
    request.headers.get('host'),
    request.headers.get('x-forwarded-host'),
    safeUrlHost(request.url),
  ]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .map((value) => value.split(',', 1)[0]!.trim().toLowerCase());
  return hosts.includes(originHost);
}

function safeUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The HTTP status each refusal answers with. */
export const CLAIM_REFUSAL_STATUS: Record<OwnerClaimRefusal, number> = {
  INVALID_OWNER: 400,
  SAME_OWNER: 409,
  SOURCE_NOT_ANONYMOUS: 403,
  TARGET_ANONYMOUS: 403,
  ALREADY_CLAIMED_ELSEWHERE: 409,
  TARGET_RETIRED: 409,
  SOURCE_HAS_CLAIMS: 409,
  OWNER_BUSY: 503,
};

/** The `Retry-After` (seconds) a refusal answers with, when retrying as is can succeed. */
export const CLAIM_REFUSAL_RETRY_AFTER: Partial<Record<OwnerClaimRefusal, number>> = {
  OWNER_BUSY: 2,
};

/**
 * The response to a refused claim: its status and code, the cookies the
 * outcome carries, and `Retry-After` for a retryable refusal.
 */
export function claimRefusalResponse(
  outcome: Extract<PendingClaimOutcome, { ok: false }>,
  headers: Headers,
): Response {
  const response = Response.json(
    { error: { code: outcome.refusal, message: outcome.message } },
    { status: CLAIM_REFUSAL_STATUS[outcome.refusal], headers },
  );
  const retryAfter = CLAIM_REFUSAL_RETRY_AFTER[outcome.refusal];
  if (retryAfter !== undefined) response.headers.set('retry-after', String(retryAfter));
  return response;
}

/**
 * Refusals after which the anonymous credential can never be claimed by this
 * owner, so the browser should stop presenting it: it was already claimed
 * (here or by another account).
 */
const CLEARS_CREDENTIAL: ReadonlySet<OwnerClaimRefusal> = new Set(['ALREADY_CLAIMED_ELSEWHERE']);

export type PendingClaimOutcome =
  | { ok: true; result: ClaimOwnerResult; setCookies: readonly string[] }
  | { ok: false; refusal: OwnerClaimRefusal; message: string; setCookies: readonly string[] };

/**
 * Run the claim `principal.pendingClaim` names, and say which cookies to send
 * back: the authenticator's `clearPendingClaim` values once the anonymous
 * credential is spent. A failure that is not a refusal (the database is down)
 * throws, and nothing is cleared.
 */
export async function runPendingClaim(
  principal: OwnerPrincipal,
  options: Pick<ClaimOwnerOptions, 'provider'> = {},
): Promise<PendingClaimOutcome> {
  const clear = () => getOwnerAuthenticator().clearPendingClaim?.() ?? [];
  try {
    const result = await claimPendingOwner(principal, options);
    return { ok: true, result, setCookies: clear() };
  } catch (error) {
    if (!(error instanceof OwnerClaimError)) throw error;
    return {
      ok: false,
      refusal: error.code,
      message: error.message,
      setCookies: CLEARS_CREDENTIAL.has(error.code) ? clear() : [],
    };
  }
}

/** Which trigger claims a pending anonymous owner: see `OWNER_CLAIM_TRIGGER`. */
export type OwnerClaimTrigger = 'explicit' | 'auto';

/**
 * `OWNER_CLAIM_TRIGGER`: `explicit` (the default) claims only on
 * `POST /api/identity/claim`; `auto` claims on the first route request that
 * carries a pending claim. Anything else is a configuration error, reported at
 * boot (`instrumentation.ts`).
 */
export function resolveOwnerClaimTrigger(): OwnerClaimTrigger {
  const raw = process.env.OWNER_CLAIM_TRIGGER?.trim();
  if (!raw || raw === 'explicit') return 'explicit';
  if (raw === 'auto') return 'auto';
  throw new Error(`OWNER_CLAIM_TRIGGER must be "explicit" or "auto", got ${JSON.stringify(raw)}.`);
}
