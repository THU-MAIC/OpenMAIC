/**
 * Retired owner ids, and the identity lock that orders writes against their
 * retirement.
 *
 * A claim (`./owner-claims.ts`) moves an anonymous owner's work to an account
 * and records the move in `owner_merges`. From then on the anonymous id is
 * retired: core forwards it to the account for work that runs on behalf of an
 * owner after the request that named it (an agent run, a generation job), and
 * refuses writes a request makes under it.
 *
 * ## The identity lock
 *
 * Every write that creates or changes an owner's rows takes a per-owner
 * advisory lock as its transaction's first statement, in shared mode; a claim
 * takes the same lock in exclusive mode for both owners it joins, before it
 * touches a row. So a write either commits before the claim starts (and the
 * claim moves what it wrote) or runs after the claim committed (and sees the
 * id retired). Because it is the first lock on both sides, no write can hold a
 * row the claim needs while waiting for the claim: the lock-order deadlocks a
 * multi-table re-key would otherwise risk with document saves, asset
 * allocations and runtime writes cannot form.
 *
 * The retirement read is a separate statement after the lock: under READ
 * COMMITTED a statement's snapshot is taken when it starts, so a read in the
 * same statement as a lock wait could miss a claim that committed during the
 * wait.
 */
import { createHash } from 'node:crypto';

import { DocumentWriteRefusedError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';

import { getOwnerAuthenticator } from '@/lib/server/identity/registry';
import { isStorableOwnerId } from '@/lib/server/identity/types';

export const OWNER_MERGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_merges (
  from_owner_id TEXT PRIMARY KEY,
  to_owner_id TEXT NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_assurance TEXT,
  moved JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT owner_merges_distinct CHECK (from_owner_id <> to_owner_id)
);

CREATE INDEX IF NOT EXISTS owner_merges_to_idx ON owner_merges (to_owner_id);
`;

export async function ensureOwnerMergeSchema(queryable: Queryable): Promise<void> {
  for (const sql of OWNER_MERGES_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
}

/**
 * The namespace of identity lock keys. The key of an owner is a 64-bit hash of
 * this prefix and the id: a lock key, never an owner id.
 */
const IDENTITY_LOCK_NAMESPACE = 'openmaic.owner-identity:';

/**
 * The identity lock key of an owner: the first 64 bits of a SHA-256 of the
 * namespaced id, as a signed bigint. Computed here rather than in SQL so a
 * lock is one statement; every instance of the application computes the same
 * key, which is all advisory locks need.
 */
export function ownerIdentityLockKey(ownerId: string): bigint {
  const digest = createHash('sha256')
    .update(`${IDENTITY_LOCK_NAMESPACE}${ownerId}`, 'utf8')
    .digest();
  return digest.readBigInt64BE(0);
}

export type IdentityLockMode = 'shared' | 'exclusive';

/**
 * Take the identity lock of every owner in `ownerIds`, transaction-scoped.
 *
 * Several locks are taken in ascending key order, the one order every caller
 * shares, so two claims that name an owner in common cannot each hold one of
 * the other's locks. Ids whose keys collide share one lock, which only
 * serializes two unrelated owners.
 */
export async function lockOwnerIdentities(
  tx: Queryable,
  ownerIds: readonly string[],
  mode: IdentityLockMode,
): Promise<void> {
  const ordered = [...new Set(ownerIds.map(ownerIdentityLockKey))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const lock = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  for (const key of ordered) {
    await tx.query(`SELECT ${lock}($1::bigint)`, [key.toString()]);
  }
}

/** The owner a claim retired `ownerId` into, or `null`. One hop: see `./owner-claims.ts`. */
export async function readOwnerRetirement(
  queryable: Queryable,
  ownerId: string,
): Promise<string | null> {
  const result = await queryable.query<{ to_owner_id: string } & Record<string, unknown>>(
    'SELECT to_owner_id FROM owner_merges WHERE from_owner_id = $1',
    [ownerId],
  );
  return result.rows[0]?.to_owner_id ?? null;
}

/**
 * The current owner of `ownerId`: the account a claim forwarded it to, then
 * whatever the configured authenticator's own `canonicalize` makes of that.
 * Runs on the caller's transaction.
 */
export async function canonicalizeOwner(tx: Queryable, ownerId: string): Promise<string> {
  const claimed = (await readOwnerRetirement(tx, ownerId)) ?? ownerId;
  const authenticator = getOwnerAuthenticator();
  if (!authenticator.canonicalize) return claimed;
  const canonical: unknown = await authenticator.canonicalize(tx, claimed);
  if (!isStorableOwnerId(canonical)) {
    throw new Error(
      `Owner authenticator ${authenticator.name}: canonicalize must resolve a storable owner id`,
    );
  }
  return canonical;
}

/**
 * The code a write under a retired owner is refused with. Answered as `403`
 * wherever document refusals are (the persistence route's document handler),
 * and by the routes that check it themselves.
 */
export const OWNER_RETIRED = 'OWNER_RETIRED';

/**
 * A write named an owner a claim has retired: the request still presents the
 * anonymous identity whose work was claimed into an account. A
 * {@link DocumentWriteRefusedError}, so every path that already turns a
 * refused document write into a `403` does the same with it.
 */
export class OwnerRetiredError extends DocumentWriteRefusedError {
  constructor(
    readonly ownerId: string,
    stageId = '',
  ) {
    super(stageId, OWNER_RETIRED, 'This identity was merged into an account; sign in to continue.');
  }
}

export function isOwnerRetiredError(error: unknown): error is OwnerRetiredError {
  return (
    error instanceof OwnerRetiredError ||
    (error instanceof DocumentWriteRefusedError && error.code === OWNER_RETIRED)
  );
}

/** The response a route gives a request refused with {@link OwnerRetiredError}. */
export function ownerRetiredResponse(headers?: HeadersInit): Response {
  return Response.json(
    {
      error: {
        code: OWNER_RETIRED,
        message: 'This identity was merged into an account; sign in to continue.',
      },
    },
    { status: 403, headers },
  );
}

/**
 * The write fence of a request: the shared identity lock of `ownerId`, then a
 * refusal if the owner is retired. Call it as the first statement of the
 * write's transaction.
 */
export async function fenceOwnerWrite(tx: Queryable, ownerId: string, stageId?: string) {
  await lockOwnerIdentities(tx, [ownerId], 'shared');
  if ((await canonicalizeOwner(tx, ownerId)) !== ownerId) {
    throw new OwnerRetiredError(ownerId, stageId);
  }
}

/**
 * The write fence of background work: the shared identity lock of `ownerId`,
 * then the owner the write belongs to now. A run that started before a claim
 * keeps working for the account its owner was claimed into. Call it as the
 * first statement of the write's transaction and write under the result.
 */
export async function forwardOwnerWrite(tx: Queryable, ownerId: string): Promise<string> {
  await lockOwnerIdentities(tx, [ownerId], 'shared');
  return canonicalizeOwner(tx, ownerId);
}

/**
 * Whether `ownerId` is retired, outside any transaction: the cheap pre-check a
 * route runs before it starts writing. The transactional fences above are
 * what make the refusal exact.
 */
export async function isOwnerRetired(queryable: Queryable, ownerId: string): Promise<boolean> {
  return (await canonicalizeOwner(queryable, ownerId)) !== ownerId;
}

/**
 * The current owner of a stored owner id, read on this deployment's pool (no
 * transaction, no lock): for background work deciding whose courses it is
 * looking at. Writes still go through a fence.
 */
export async function canonicalizeStoredOwner(ownerId: string): Promise<string> {
  const { getServerPersistenceProvider } = await import('./server-provider');
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return canonicalizeOwner(pool as unknown as Queryable, ownerId);
}
