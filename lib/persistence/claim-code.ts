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
 * Where the codes live depends on the deployment. With a database, they live in
 * `claim_codes`: on a serverless host the request that mints a code and the one
 * that redeems it land on different instances, and an in-process store answers
 * every redemption "unknown" (found on prod, 2026-09-21 — the local dev server
 * is a single process, so nothing local could show it). Without a database the
 * store stays in memory, where one process is all there is.
 */
import { createHash, randomBytes } from 'node:crypto';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

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
  const code = randomBytes(CLAIM_CODE_BYTES).toString('hex');
  const expiresAt = now + CLAIM_TTL_MS;
  await (await resolveBackend()).put(hashCode(canonicalClaimCode(code)), owner, expiresAt, now);
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
  // The lookup is keyed on the digest, not a comparison against the secret: an
  // attacker's guess is hashed before anything is compared, so there is no
  // character-by-character prefix for timing to leak.
  const taken = await (await resolveBackend()).take(hashCode(canonicalClaimCode(code)));
  if (!taken) return undefined;
  if (taken.expiresAt <= now) return undefined;
  return { owner: taken.owner };
}

/**
 * Where codes are kept. `take` removes the record in the same step that reads
 * it, so a second redemption of the same code — including one racing on
 * another instance — finds nothing. Spent and unknown are then the same answer
 * by construction, and expiry is judged by the caller.
 */
export interface ClaimBackend {
  put(hash: string, owner: string, expiresAt: number, now: number): Promise<void>;
  take(hash: string): Promise<{ owner: string; expiresAt: number } | undefined>;
}

const memoryBackend: ClaimBackend = {
  async put(hash, owner, expiresAt, now) {
    prune(now);
    claims.set(hash, { owner, expiresAt, used: false });
  },
  async take(hash) {
    const record = claims.get(hash);
    if (!record || record.used) return undefined;
    // Burn it before returning: kept as spent so the store dump still shows it.
    claims.set(hash, { ...record, used: true });
    return { owner: record.owner, expiresAt: record.expiresAt };
  },
};

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Claim codes in PostgreSQL, shared by every instance of the deployment. */
export function pgClaimBackend(db: Queryable): ClaimBackend {
  let ready: Promise<unknown> | undefined;
  const ensure = () =>
    (ready ??= db
      .query(
        `CREATE TABLE IF NOT EXISTS claim_codes (
           hash TEXT PRIMARY KEY,
           owner TEXT NOT NULL,
           expires_at BIGINT NOT NULL
         )`,
      )
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      }));
  return {
    async put(hash, owner, expiresAt, now) {
      await ensure();
      // Expired rows can never be redeemed; clearing them here keeps the table
      // at roughly the codes of the last ten minutes without a scheduled job.
      await db.query('DELETE FROM claim_codes WHERE expires_at <= $1', [now]);
      await db.query('INSERT INTO claim_codes (hash, owner, expires_at) VALUES ($1, $2, $3)', [
        hash,
        owner,
        expiresAt,
      ]);
    },
    async take(hash) {
      await ensure();
      const { rows } = await db.query(
        'DELETE FROM claim_codes WHERE hash = $1 RETURNING owner, expires_at',
        [hash],
      );
      const row = rows[0];
      if (!row) return undefined;
      return { owner: String(row.owner), expiresAt: Number(row.expires_at) };
    },
  };
}

let backendOverride: ClaimBackend | undefined;
let pgBackend: { url: string; backend: ClaimBackend } | undefined;

async function resolveBackend(): Promise<ClaimBackend> {
  if (backendOverride) return backendOverride;
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return memoryBackend;
  if (pgBackend?.url !== url) {
    const { pool } = await getServerPersistenceProvider(url);
    pgBackend = { url, backend: pgClaimBackend(pool as unknown as Queryable) };
  }
  return pgBackend.backend;
}

/** Route codes through `backend` instead of the deployment's own. Exists for tests. */
export function setClaimBackendForTests(backend: ClaimBackend | undefined): void {
  backendOverride = backend;
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
