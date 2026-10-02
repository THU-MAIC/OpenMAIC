/**
 * Edge-safe access-token constants and timestamp validation.
 *
 * Both the Node verifier (`lib/server/access-token.ts`) and the Edge middleware
 * verifier import this module, so it must stay dependency-free: no `node:*`
 * built-ins and no `crypto` import. Keeping the lifetime policy here means the
 * two verifiers cannot drift apart.
 */

/** How long an access token stays valid after it is minted: 7 days. */
export const ACCESS_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** {@link ACCESS_TOKEN_MAX_AGE_SECONDS} expressed in milliseconds. */
export const ACCESS_TOKEN_MAX_AGE_MS = ACCESS_TOKEN_MAX_AGE_SECONDS * 1000;

/**
 * How far a token timestamp may lead the server clock. A small allowance keeps
 * modest clock drift between the minting and verifying hosts from rejecting a
 * freshly issued token.
 */
export const ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 5 * 60;

/**
 * Canonical HMAC-SHA256 signature: exactly 64 lowercase hex characters.
 *
 * Shared by both verifiers so they agree on non-canonical signatures. Node's
 * `Buffer.from(sig, 'hex')` silently accepts uppercase hex and stops at the
 * first non-hex character, whereas the constant-time string compare in the Edge
 * verifier rejects both; without this check the Node and Edge verifiers would
 * disagree about the same token.
 */
const ACCESS_TOKEN_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/** Whether `signature` is a canonical 64-character lowercase hex signature. */
export function isAccessTokenSignatureFormatValid(signature: string): boolean {
  return ACCESS_TOKEN_SIGNATURE_PATTERN.test(signature);
}

/**
 * Validate the `timestamp` half of a `<timestamp>.<signature>` token.
 *
 * Returns false when the timestamp is not a plain base-10 integer string, when
 * it is older than {@link ACCESS_TOKEN_MAX_AGE_MS}, or when it leads the server
 * clock by more than {@link ACCESS_TOKEN_CLOCK_SKEW_SECONDS}. The HMAC
 * signature is verified separately by the caller.
 *
 * @param timestamp Raw token prefix, e.g. `"1750000000000"`.
 * @param now Server time in epoch milliseconds (injectable for tests).
 */
export function isAccessTokenTimestampValid(timestamp: string, now: number = Date.now()): boolean {
  // Rejects empty strings, signs, decimals, and hex/exponent forms.
  if (!/^\d+$/.test(timestamp)) return false;

  const timestampMs = Number(timestamp);
  // Defense in depth: the future-skew check below already rejects an overflowing
  // digit string (`Infinity` makes `ageMs` negative), but keeping the guard makes
  // that reasoning explicit and survives future edits to the range checks.
  if (!Number.isFinite(timestampMs)) return false;

  const ageMs = now - timestampMs;
  if (ageMs > ACCESS_TOKEN_MAX_AGE_MS) return false;
  if (ageMs < -ACCESS_TOKEN_CLOCK_SKEW_SECONDS * 1000) return false;

  return true;
}
