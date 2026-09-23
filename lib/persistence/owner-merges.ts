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

import { StorageBusyError } from '@openmaic/storage';

import { getOwnerAuthenticator } from '@/lib/server/identity/registry';
import { principalFromStoredOwner } from '@/lib/server/identity/stored-owner';

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
 * How long a write waits for an owner's identity lock before it gives up with
 * {@link OwnerBusyError}: only as long as a claim of that owner holds it.
 * `OWNER_WRITE_LOCK_WAIT_MS` tunes it (a positive integer of milliseconds).
 */
const DEFAULT_WRITE_LOCK_WAIT_MS = 30_000;

export function resolveLockWaitMs(variable: string, fallback: number): number {
  const raw = process.env[variable]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${variable} must be a positive integer number of milliseconds.`);
  }
  return parsed;
}

/** SQLSTATEs that mean "this could not run now; retry as it is". */
const RETRYABLE_LOCK_CODES = new Set(['55P03', '40P01', '40001']);

/** Whether `error` is lock contention: a driver SQLSTATE, or the storage package's wrapping of one. */
export function isLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  if (name === 'StorageLockUnavailableError') return true;
  return typeof code === 'string' && RETRYABLE_LOCK_CODES.has(code);
}

/** The code a write or claim that lost a lock race answers with, as `503` and `Retry-After`. */
export const OWNER_BUSY = 'OWNER_BUSY';

/**
 * An owner write or a claim could not take the owner's identity lock in time
 * (a claim of the owner is running), or lost a deadlock or serialization race.
 * Nothing was written; retrying as it is will succeed once the claim is done.
 * A {@link StorageBusyError}, so the storage package's handlers answer it
 * `503` with `Retry-After` on every contract.
 */
export class OwnerBusyError extends StorageBusyError {
  constructor(cause?: unknown) {
    super(OWNER_BUSY, 'This identity is being updated; retry shortly.', 2, { cause });
  }
}

export function isOwnerBusyError(error: unknown): error is OwnerBusyError {
  return (
    error instanceof OwnerBusyError ||
    (error instanceof StorageBusyError && error.code === OWNER_BUSY)
  );
}

/** The response a route gives a write refused with {@link OwnerBusyError}. */
export function ownerBusyResponse(headers?: HeadersInit): Response {
  const response = Response.json(
    { error: { code: OWNER_BUSY, message: 'This identity is being updated; retry shortly.' } },
    { status: 503, headers },
  );
  response.headers.set('retry-after', '2');
  return response;
}

/**
 * Take the identity lock of every owner in `ownerIds`, transaction-scoped.
 *
 * Several locks are taken in ascending key order, the one order every caller
 * shares, so two claims that name an owner in common cannot each hold one of
 * the other's locks. Ids whose keys collide share one lock, which only
 * serializes two unrelated owners.
 *
 * Each wait is bounded by `waitMs` (set as the transaction's `lock_timeout`
 * in the same statement, and left in place for the rest of the transaction,
 * which only bounds its later waits too). Running out of it is
 * {@link OwnerBusyError}.
 */
export async function lockOwnerIdentities(
  tx: Queryable,
  ownerIds: readonly string[],
  mode: IdentityLockMode,
  waitMs = resolveLockWaitMs('OWNER_WRITE_LOCK_WAIT_MS', DEFAULT_WRITE_LOCK_WAIT_MS),
): Promise<void> {
  const ordered = [...new Set(ownerIds.map(ownerIdentityLockKey))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const lock = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  try {
    for (const [index, key] of ordered.entries()) {
      // The timeout is set in the first lock's own statement (the target list
      // is evaluated in order, so it is in force when the lock waits): one
      // round trip per lock, which matters on every write.
      await tx.query(
        index === 0
          ? `SELECT set_config('lock_timeout', $2, true), ${lock}($1::bigint)`
          : `SELECT ${lock}($1::bigint)`,
        index === 0 ? [key.toString(), `${waitMs}ms`] : [key.toString()],
      );
    }
  } catch (error) {
    if (isLockContention(error)) throw new OwnerBusyError(error);
    throw error;
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
 * The current owner of `ownerId`: the account a claim forwarded it to, or the
 * id itself. One indexed lookup: claims never chain (`./owner-claims.ts`).
 * Core owns forwarding for every host; there is no host hook here. A host with
 * account merges of its own moves the rows with `claimOwner` (or its own
 * participants) and records them in `owner_merges` the same way.
 */
export async function canonicalizeOwner(queryable: Queryable, ownerId: string): Promise<string> {
  return (await readOwnerRetirement(queryable, ownerId)) ?? ownerId;
}

/**
 * Whether `ownerId` can have been retired at all. A claim only ever retires an
 * owner the configured authenticator describes as anonymous
 * (`principalFromStoredOwner`), so for any other owner the retirement read is
 * skipped: its answer is known. The identity lock is still taken for every
 * owner, because a claim locks its target too, and that is what keeps an
 * account's own writes from interleaving with a claim into it.
 */
function mayBeRetired(ownerId: string): boolean {
  return principalFromStoredOwner(ownerId).kind === 'anonymous';
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

/**
 * The `Set-Cookie` values that drop a retired anonymous credential: the
 * configured authenticator's `clearPendingClaim`. Every `OWNER_RETIRED`
 * response carries them, so a browser whose claim response was lost (a closed
 * tab, a parallel request with the old cookie) stops presenting the retired
 * identity and is given a fresh one on its next request, instead of being
 * refused forever.
 */
export function retiredCredentialCookies(): readonly string[] {
  return getOwnerAuthenticator().clearPendingClaim?.() ?? [];
}

/** The response a route gives a request refused with {@link OwnerRetiredError}. */
export function ownerRetiredResponse(headers?: HeadersInit): Response {
  const response = Response.json(
    {
      error: {
        code: OWNER_RETIRED,
        message: 'This identity was merged into an account; sign in to continue.',
      },
    },
    { status: 403, headers },
  );
  for (const cookie of retiredCredentialCookies()) response.headers.append('Set-Cookie', cookie);
  return response;
}

/**
 * The response for an owner write that failed because of a claim -- retired
 * (`403 OWNER_RETIRED`) or busy (`503 OWNER_BUSY`) -- or `undefined` for any
 * other error. Routes that write under the request's owner map with it.
 */
export function ownerWriteErrorResponse(
  error: unknown,
  headers?: HeadersInit,
): Response | undefined {
  if (isOwnerRetiredError(error)) return ownerRetiredResponse(headers);
  if (isOwnerBusyError(error)) return ownerBusyResponse(headers);
  return undefined;
}

/**
 * The write fence of a request: the shared identity lock of `ownerId`, then a
 * refusal if the owner is retired. Call it as the first statement of the
 * write's transaction.
 */
export async function fenceOwnerWrite(tx: Queryable, ownerId: string, stageId?: string) {
  await lockOwnerIdentities(tx, [ownerId], 'shared');
  if (!mayBeRetired(ownerId)) return;
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
  return mayBeRetired(ownerId) ? canonicalizeOwner(tx, ownerId) : ownerId;
}

/**
 * Whether `ownerId` is retired, outside any transaction: the cheap pre-check a
 * route runs before it starts writing. The transactional fences above are
 * what make the refusal exact.
 */
export async function isOwnerRetired(queryable: Queryable, ownerId: string): Promise<boolean> {
  return mayBeRetired(ownerId) && (await canonicalizeOwner(queryable, ownerId)) !== ownerId;
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

/**
 * `403 OWNER_RETIRED` when `ownerId` is retired, else `undefined`. For a
 * route whose write addresses a row by id and found nothing: the row may have
 * moved with a claim, and a retired requester should hear why rather than a
 * bare not-found. Reads the claim records only for an owner that can be
 * retired (an anonymous one).
 */
export async function ownerRetiredResponseIfRetired(
  ownerId: string,
  headers?: HeadersInit,
): Promise<Response | undefined> {
  if (!mayBeRetired(ownerId)) return undefined;
  return (await canonicalizeStoredOwner(ownerId)) !== ownerId
    ? ownerRetiredResponse(headers)
    : undefined;
}
