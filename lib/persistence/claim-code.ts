/**
 * One-time claim codes: how a second device adopts the owner identity of the
 * first one.
 *
 * Device A asks for a code, reads it out loud (or off the screen), and device B
 * hands it back. A redeemed code makes device B resolve to A's owner id, so both
 * land in the same account-scoped partition.
 *
 * Three properties this module owes the rest of the system:
 *
 * - **The code lives for ten minutes and no longer.** {@link CLAIM_TTL_MS} is a
 *   signed ceiling, not a default a deployment may stretch: the window is the
 *   whole reason a spoken code is safe to say out loud.
 * - **Only a hash is retained.** A leaked dump of this store must not let anyone
 *   redeem anything, so the plaintext code exists only in the response that
 *   carries it to device A.
 * - **All three failure modes are indistinguishable.** Wrong, expired and
 *   already-used all return `undefined`. A caller cannot tell them apart, so it
 *   cannot leak to an attacker which guesses were "close".
 *
 * State is per-process and deliberately in memory. A claim code is a handshake
 * measured in minutes between two devices of one person; surviving a restart is
 * not a property worth a table, and losing the store on restart only costs the
 * user one re-press of "get a code".
 */
import { createHash, randomBytes } from 'node:crypto';

import { canonicalClaimCode } from './claim-code-format';

/** AC-3: the signed ceiling for how long a claim code stays redeemable. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

/** Bytes of entropy behind a code; 16 bytes is 128 bits, shown as 32 hex chars. */
const CLAIM_CODE_BYTES = 16;

/**
 * Hard cap on live claim codes. Minting is reachable by anyone who can reach
 * the app, so the store is bounded: past the cap the oldest entries go first.
 */
const MAX_LIVE_CLAIMS = 10_000;

interface ClaimRecord {
  owner: string;
  expiresAt: number;
  used: boolean;
}

/** Keyed by the SHA-256 of the code — never by the code itself. */
const claims = new Map<string, ClaimRecord>();

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Forget entries that can no longer be redeemed, then bound what is left. */
function prune(now: number): void {
  for (const [hash, record] of claims) {
    if (record.used || record.expiresAt <= now) claims.delete(hash);
  }
  while (claims.size >= MAX_LIVE_CLAIMS) {
    const oldest = claims.keys().next().value;
    if (oldest === undefined) break;
    claims.delete(oldest);
  }
}

/**
 * Mint a code that adopts `owner` for whoever redeems it inside the window.
 *
 * Async by contract, not by need: a deployment that later moves this store off
 * the process (shared cache, database) must not have to change its callers.
 */
export async function mintClaimCode(
  owner: string,
  now: number = Date.now(),
): Promise<{ code: string; expiresAt: number }> {
  prune(now);
  const code = randomBytes(CLAIM_CODE_BYTES).toString('hex');
  const expiresAt = now + CLAIM_TTL_MS;
  claims.set(hashCode(canonicalClaimCode(code)), { owner, expiresAt, used: false });
  return { code, expiresAt };
}

/**
 * Redeem `code` once. Returns the owner it adopts, or `undefined` for every
 * failure — unknown, expired, or already redeemed (AC-5). Callers that need to
 * report a failure must report the same thing for all three.
 */
export async function redeemClaimCode(
  code: string,
  now: number = Date.now(),
): Promise<{ owner: string } | undefined> {
  const hash = hashCode(canonicalClaimCode(code));
  const record = claims.get(hash);
  // The lookup is a map hit on the digest, not a comparison against the secret:
  // an attacker's guess is hashed before anything is compared, so there is no
  // character-by-character prefix for timing to leak.
  if (!record) return undefined;
  if (record.used) return undefined;
  if (record.expiresAt <= now) return undefined;

  // Burn it before returning: a second redemption of the same code must lose,
  // including one already in flight on another request.
  claims.delete(hash);
  claims.set(hash, { ...record, used: true });
  return { owner: record.owner };
}

/**
 * Snapshot of the stored records, for tests that assert the plaintext code is
 * nowhere in the store. Not exported over any HTTP route.
 */
export function dumpClaimStore(): ReadonlyArray<{
  hash: string;
  owner: string;
  expiresAt: number;
  used: boolean;
}> {
  return [...claims].map(([hash, record]) => ({ hash, ...record }));
}

/** Drop every stored claim. Exists for tests. */
export function resetClaimStore(): void {
  claims.clear();
}
