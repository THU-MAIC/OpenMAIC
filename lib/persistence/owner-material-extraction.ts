/**
 * Owner-level extraction state for library sources (RFC #1716 §2–3).
 *
 * The session chain (`@openmaic/storage/material/pg`) keeps queueing, leases
 * and results on each conversation's copy of a material, so a second
 * conversation extracts the same upload again. This module keeps them on the
 * owner's `owner_material` row instead, so every conversation shares one
 * extraction of one source.
 *
 * `extract_material` ensures a source's extraction here, the owner runner
 * (`lib/server/material-extraction/owner-extraction.ts`) claims and publishes,
 * and the material tools read the results through the shared resolver
 * (RFC #1716 Phase 2).
 *
 * ## State
 *
 * The status lives where the public view already shows it, in the
 * `extraction` JSONB (`{ status }`): idle, pending, running, done or failed.
 * The rest is private (`./owner-materials.ts` lists the columns):
 *
 * - `extraction_token`: the current claim. Every claim mints a fresh one and
 *   every write of a claim names it, so a worker whose lease was taken over,
 *   or that comes back after a manual restart, cannot publish, settle or
 *   renew -- even when the same process claims the source again. An
 *   allocation it starts afterwards is refused; one already under way when
 *   it loses the claim can leave a pending entry, which it can never publish
 *   and which expires.
 * - `extraction_claims`: claims since the last explicit start. Each claim,
 *   a takeover of an expired lease included, spends one; a source whose
 *   lease keeps expiring fails once the budget is spent instead of being
 *   claimed forever.
 * - `extraction_result`: the latest successful extraction, written in the
 *   same statement that sets `done`, so `done` without a result cannot be
 *   stored. Its `revision` is the token of the claim that published it.
 *
 * What a claim guarantees is bounded: a finite number of claims and no late
 * write. It does not bound how long one claim runs -- a provider that never
 * returns while its heartbeat keeps the lease alive stays running.
 *
 * ## Publishing
 *
 * {@link publishOwnerMaterialExtraction} commits the result in one
 * transaction: the owner's write fence (forwarded, so a run that started
 * before a claim of its owner publishes for the account it moved to), the
 * material rows in one ascending lock, the claim check, one reference-root
 * call for every asset the result keeps, the derivative rows and the source
 * row. A check that fails writes nothing at all. The assets are allocated
 * beforehand, each in its own transaction ({@link checkOwnerExtractionClaim}),
 * and an allocation that is never published expires like any other pending
 * entry; nothing here deletes an entry or a byte.
 *
 * ## Deletion
 *
 * Every write here checks `deleted_at`: a deleted source is not claimed, and
 * a claim of one cannot heartbeat, settle or publish. Deleting a material --
 * marking it, cancelling its work and withdrawing its roots together -- is
 * the library's deletion operation, not this module's.
 */
import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';

import { MATERIAL_ROOT_KIND, withMaterialRoots } from './material-roots';
import { fenceOwnerWrite, forwardOwnerWrite } from './owner-merges';

/** Claims one explicit start may spend, takeovers of an expired lease included. */
export const MAX_OWNER_EXTRACTION_CLAIMS = 3;

export type OwnerExtractionStatus = 'idle' | 'pending' | 'running' | 'done' | 'failed';

/** One claim of one source: who may write, and for which source. */
export interface OwnerExtractionClaim {
  materialId: string;
  /** The owner the source had when it was claimed; writes forward it. */
  ownerId: string;
  token: string;
  /** Claims spent so far, this one included. */
  claims: number;
  mime: string | null;
  originalName: string | null;
  /** The pre-pool object key, `''` for a source in the pool. */
  ossKey: string;
  /** The pool entry holding the source, or `null` for a pre-pool source. */
  assetId: string | null;
  sha256: string | null;
  bytes: number;
}

/** A media derivative of a source: an owner material of its own. */
export interface OwnerExtractionDerivative {
  id: string;
  kind: 'image';
  assetId: string;
  title: string;
  mime: string;
  bytes: number;
  sha256: string;
  pageNumber?: number;
  timeMs?: number;
  /**
   * What the result's text calls this derivative: a reference
   * `openmaic-derivative:<key>` in the text names it. Keys belong to the
   * result, not to a source, so a reused text names each source's own
   * derivatives (`lib/server/material-extraction/document-images.ts`).
   */
  key?: string;
}

/** The latest successful extraction of a source, as `extraction_result` stores it. */
export interface OwnerExtractionResult {
  /** Changes whenever the result does: the token of the claim that published it. */
  revision: string;
  text: { assetId: string; chars: number };
  extractor: { id: string; version: string; options: Record<string, string> };
  stats: Record<string, unknown>;
  derivatives: OwnerExtractionDerivative[];
  /** The source whose result this one reuses, when it came from the owner's cache. */
  reusedFrom?: string;
  completedAt: number;
}

/** What a publication commits; the revision is the claim's token. */
export type OwnerExtractionPublication = Omit<OwnerExtractionResult, 'revision' | 'completedAt'> & {
  /** Null when the source has no reliable content identity: never a cache hit. */
  cacheKey: string | null;
  /**
   * For a cache hit, the source the result is reused from, the revision it
   * was read at and the roots it keeps the result under: all re-checked
   * under lock, so a donor deleted, changed or no longer holding its result
   * since reading is a miss, not a publication. A cache entry keeps nothing
   * alive; only a result something still roots is reused.
   */
  donor?: {
    materialId: string;
    revision: string;
    /** Every root the donor holds its result under; each must still exist. */
    roots: Array<{ rootId: string; assetId: string }>;
  };
};

export type PublishOutcome = 'published' | 'not-authorized' | 'donor-changed';

/** An expected refusal of a write: the claim is no longer the current one. */
export class OwnerExtractionClaimLostError extends Error {
  constructor(materialId: string) {
    super(`owner extraction claim of ${materialId} is no longer current`);
    this.name = 'OwnerExtractionClaimLostError';
  }
}

const STATUS = `(extraction->>'status')`;

interface ClaimRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  status: string;
  extraction_token: string | null;
  extraction_claims: number | string;
  mime: string | null;
  original_name: string | null;
  oss_key: string;
  asset_id: string | null;
  sha256: string | null;
  bytes: number | string;
}

function statusJson(status: OwnerExtractionStatus): string {
  return JSON.stringify({ status });
}

/**
 * Ensure extraction of a source has started: idle and failed sources are
 * queued; pending, running and done ones are left alone, and completed ones
 * are never re-run. Queueing resets the claim budget, never the token.
 * Returns the source's status afterwards, or `null` when the owner has no
 * such ready, undeleted source.
 *
 * `fence: 'request'` (the default) refuses a retired owner, as a request's
 * write does. `fence: 'background'` follows a claim to the account: an agent
 * run that started before its owner was claimed keeps working for the account
 * its session moved to, as its other writes do.
 */
export async function ensureOwnerMaterialExtraction(
  withTransaction: WithTransaction,
  ownerId: string,
  materialId: string,
  options: { fence?: 'request' | 'background' } = {},
): Promise<{ status: OwnerExtractionStatus; queued: boolean } | null> {
  return withTransaction(async (tx) => {
    if ((options.fence ?? 'request') === 'request') await fenceOwnerWrite(tx, ownerId);
    else ownerId = await forwardOwnerWrite(tx, ownerId);
    const queued = await tx.query<{ id: string }>(
      `UPDATE owner_material
          SET extraction = $3::jsonb, extraction_claims = 0, extraction_token = NULL,
              extraction_lease_at = NULL, extraction_error = NULL
        WHERE id = $1 AND owner_id = $2 AND kind = 'source' AND status = 'ready'
          AND deleted_at IS NULL
          AND (extraction IS NULL OR ${STATUS} IS NULL OR ${STATUS} IN ('idle', 'failed'))
        RETURNING id`,
      [materialId, ownerId, statusJson('pending')],
    );
    if (queued.rows.length > 0) return { status: 'pending' as const, queued: true };
    const current = await tx.query<{ status: string | null }>(
      `SELECT ${STATUS} AS status FROM owner_material
        WHERE id = $1 AND owner_id = $2 AND kind = 'source' AND status = 'ready'
          AND deleted_at IS NULL`,
      [materialId, ownerId],
    );
    const row = current.rows[0];
    if (!row) return null;
    return { status: (row.status ?? 'idle') as OwnerExtractionStatus, queued: false };
  });
}

export interface ClaimOwnerExtractionOptions {
  leaseTtlMs: number;
  now: number;
  createToken: () => string;
  maxClaims?: number;
}

/**
 * Claim the oldest pending source, or one whose running lease expired.
 *
 * One candidate at a time, `SKIP LOCKED`: a row another transaction holds
 * (a claim of its owner, another worker) is passed over rather than waited
 * for. A candidate whose budget is spent is settled `failed` instead of
 * claimed, and the next candidate is tried.
 */
export async function claimNextOwnerMaterialExtraction(
  queryable: Queryable,
  options: ClaimOwnerExtractionOptions,
): Promise<OwnerExtractionClaim | null> {
  if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
    throw new Error('owner extraction: leaseTtlMs must be a positive integer');
  }
  const maxClaims = options.maxClaims ?? MAX_OWNER_EXTRACTION_CLAIMS;
  const staleBefore = options.now - options.leaseTtlMs;
  for (;;) {
    const token = options.createToken();
    const result = await queryable.query<ClaimRow>(
      `WITH candidate AS (
         SELECT id FROM owner_material
          WHERE kind = 'source' AND status = 'ready' AND deleted_at IS NULL
            AND (${STATUS} = 'pending'
              OR (${STATUS} = 'running' AND extraction_lease_at < $1::double precision))
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE owner_material AS material
          SET extraction = CASE WHEN material.extraction_claims < $4::int
                THEN $5::jsonb ELSE $6::jsonb END,
              extraction_token = CASE WHEN material.extraction_claims < $4::int
                THEN $2::text ELSE NULL END,
              extraction_claims = CASE WHEN material.extraction_claims < $4::int
                THEN material.extraction_claims + 1 ELSE material.extraction_claims END,
              extraction_lease_at = CASE WHEN material.extraction_claims < $4::int
                THEN $3::double precision ELSE NULL END,
              extraction_error = CASE WHEN material.extraction_claims < $4::int
                THEN NULL ELSE 'extraction did not finish within its claim budget' END
         FROM candidate
        WHERE material.id = candidate.id
        RETURNING material.id, material.owner_id, (material.extraction->>'status') AS status,
                  material.extraction_token, material.extraction_claims, material.mime,
                  material.original_name, material.oss_key, material.asset_id, material.sha256,
                  material.bytes`,
      [staleBefore, token, options.now, maxClaims, statusJson('running'), statusJson('failed')],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.status !== 'running') continue;
    return {
      materialId: row.id,
      ownerId: row.owner_id,
      token: row.extraction_token!,
      claims: Number(row.extraction_claims),
      mime: row.mime,
      originalName: row.original_name,
      ossKey: row.oss_key,
      assetId: row.asset_id,
      sha256: row.sha256,
      bytes: Number(row.bytes),
    };
  }
}

const CURRENT_CLAIM = `id = $1 AND extraction_token = $2 AND ${STATUS} = 'running'
  AND kind = 'source' AND deleted_at IS NULL`;

/** Renew a claim's lease. `false` when the claim is no longer current. */
export async function heartbeatOwnerMaterialExtraction(
  queryable: Queryable,
  claim: Pick<OwnerExtractionClaim, 'materialId' | 'token'>,
  now: number,
): Promise<boolean> {
  const result = await queryable.query(
    `UPDATE owner_material SET extraction_lease_at = $3::double precision
      WHERE ${CURRENT_CLAIM} RETURNING id`,
    [claim.materialId, claim.token, now],
  );
  return result.rows.length > 0;
}

/**
 * Settle a failed claim: back to pending while the budget allows a retryable
 * failure another claim, otherwise failed with its reason. A claim that is no
 * longer current changes nothing and gets `null`.
 */
export async function settleOwnerMaterialExtractionFailure(
  queryable: Queryable,
  claim: Pick<OwnerExtractionClaim, 'materialId' | 'token'>,
  failure: { reason: string; retryable: boolean; maxClaims?: number },
): Promise<OwnerExtractionStatus | null> {
  const maxClaims = failure.maxClaims ?? MAX_OWNER_EXTRACTION_CLAIMS;
  const result = await queryable.query<{ status: string }>(
    `UPDATE owner_material
        SET extraction = CASE WHEN $4::boolean AND extraction_claims < $5::int
              THEN $6::jsonb ELSE $7::jsonb END,
            extraction_error = $3::text, extraction_token = NULL, extraction_lease_at = NULL
      WHERE ${CURRENT_CLAIM}
      RETURNING (extraction->>'status') AS status`,
    [
      claim.materialId,
      claim.token,
      failure.reason.slice(0, 4000),
      failure.retryable,
      maxClaims,
      statusJson('pending'),
      statusJson('failed'),
    ],
  );
  const status = result.rows[0]?.status;
  return status === undefined ? null : (status as OwnerExtractionStatus);
}

/**
 * Inside an allocation's transaction, after its owner fence: throw
 * {@link OwnerExtractionClaimLostError} unless the claim is still the current
 * one of an undeleted source of `ownerId`. A plain read, deliberately not a
 * row lock: an allocation writes bytes, and a lock held across that write
 * would block the claim's own heartbeat. So it refuses an allocation by a
 * claim that is already superseded, but a claim superseded after this check
 * can still commit its pending entry; whether the claim may publish is
 * decided again, under lock, when it publishes.
 */
export async function checkOwnerExtractionClaim(
  tx: Queryable,
  claim: Pick<OwnerExtractionClaim, 'materialId' | 'token'>,
  ownerId: string,
): Promise<void> {
  const current = await tx.query(
    `SELECT id FROM owner_material WHERE ${CURRENT_CLAIM} AND owner_id = $3`,
    [claim.materialId, claim.token, ownerId],
  );
  if (current.rows.length === 0) throw new OwnerExtractionClaimLostError(claim.materialId);
}

interface LockedRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  kind: string;
  folder_id: string | null;
  deleted_at: number | string | null;
  status: string | null;
  extraction_token: string | null;
  extraction_result: unknown;
}

/**
 * Commit a claim's result in one transaction, or nothing. See the module
 * docstring for the order; `not-authorized` and `donor-changed` write
 * nothing. Any other failure throws and rolls everything back.
 */
export async function publishOwnerMaterialExtraction(
  withTransaction: WithTransaction,
  claim: Pick<OwnerExtractionClaim, 'materialId' | 'ownerId' | 'token'>,
  publication: OwnerExtractionPublication,
  now: number,
): Promise<PublishOutcome> {
  const lockIds = [claim.materialId, ...(publication.donor ? [publication.donor.materialId] : [])];
  // Background work: a claim of the owner since this run started moves the
  // write to the account, which is where the source row now is. The wrapper
  // takes that forwarded fence, then these rows' locks in one ascending
  // statement, before anything below runs.
  const locks = { ownerId: claim.ownerId, fence: 'background' as const, materialIds: lockIds };
  return withMaterialRoots({ withTransaction }, locks, async ({ tx, ownerId, changeRoots }) => {
    const locked = await tx.query<LockedRow>(
      `SELECT id, owner_id, kind, folder_id, deleted_at, ${STATUS} AS status,
              extraction_token, extraction_result
         FROM owner_material
        WHERE id = ANY($1::text[])
        ORDER BY id`,
      [lockIds],
    );
    const byId = new Map(locked.rows.map((row) => [row.id, row]));
    const source = byId.get(claim.materialId);
    if (
      !source ||
      source.owner_id !== ownerId ||
      source.kind !== 'source' ||
      source.deleted_at !== null ||
      source.status !== 'running' ||
      source.extraction_token !== claim.token
    ) {
      return 'not-authorized' as const;
    }
    if (publication.donor) {
      const donor = byId.get(publication.donor.materialId);
      const result = donor?.extraction_result as OwnerExtractionResult | null | undefined;
      if (
        !donor ||
        donor.owner_id !== ownerId ||
        donor.deleted_at !== null ||
        donor.status !== 'done' ||
        result?.revision !== publication.donor.revision
      ) {
        return 'donor-changed' as const;
      }
      // A snapshot, not a guarantee. The donor's row lock holds only its text
      // root; each derivative is rooted under its own id, which this does
      // not lock. What keeps reuse safe is `changeAssetRoots` below, which
      // refuses an entry that is gone or no longer this owner's under that
      // entry's own lock. Deleting a derivative (Phase 2) must therefore go
      // through `changeAssetRoots` as well, and must not count on the donor
      // row being locked.
      const held = await tx.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM asset_root_refs AS roots
           JOIN unnest($2::text[], $3::text[]) AS wanted(root_id, asset_id)
             ON roots.root_kind = $1 AND roots.root_id = wanted.root_id
            AND roots.asset_id = wanted.asset_id`,
        [
          MATERIAL_ROOT_KIND,
          publication.donor.roots.map((root) => root.rootId),
          publication.donor.roots.map((root) => root.assetId),
        ],
      );
      if (Number(held.rows[0]?.count ?? 0) !== publication.donor.roots.length) {
        return 'donor-changed' as const;
      }
    }

    // Every asset the result keeps, under the material that keeps it. One
    // call, after the material locks, as the root contract requires; an
    // asset that is gone or no longer this owner's refuses the whole call.
    await changeRoots({
      add: [
        { materialId: claim.materialId, assetIds: [publication.text.assetId] },
        ...publication.derivatives.map((derivative) => ({
          materialId: derivative.id,
          assetIds: [derivative.assetId],
        })),
      ],
    });

    if (publication.derivatives.length > 0) {
      // Derivatives are owner materials of their own, filed with their source.
      await tx.query(
        `INSERT INTO owner_material
           (id, owner_id, kind, derived_from, mime, bytes, original_name, oss_key, sha256,
            status, extraction, created_at, asset_id, folder_id)
         SELECT derivative.id, $1, derivative.kind, $2, derivative.mime, derivative.bytes,
                derivative.title, '', derivative.sha256, 'ready', NULL, $3, derivative.asset_id, $4
           FROM unnest($5::text[], $6::text[], $7::text[], $8::double precision[], $9::text[],
                       $10::text[], $11::text[])
             AS derivative(id, kind, mime, bytes, title, sha256, asset_id)`,
        [
          ownerId,
          claim.materialId,
          now,
          source.folder_id,
          publication.derivatives.map((derivative) => derivative.id),
          publication.derivatives.map((derivative) => derivative.kind),
          publication.derivatives.map((derivative) => derivative.mime),
          publication.derivatives.map((derivative) => derivative.bytes),
          publication.derivatives.map((derivative) => derivative.title),
          publication.derivatives.map((derivative) => derivative.sha256),
          publication.derivatives.map((derivative) => derivative.assetId),
        ],
      );
    }

    const { cacheKey, donor, ...result } = publication;
    const stored: OwnerExtractionResult = {
      ...result,
      ...(donor ? { reusedFrom: donor.materialId } : {}),
      revision: claim.token,
      completedAt: now,
    };
    await tx.query(
      `UPDATE owner_material
          SET extraction = $2::jsonb, extraction_result = $3::jsonb, extraction_cache_key = $4,
              extraction_token = NULL, extraction_lease_at = NULL, extraction_error = NULL
        WHERE id = $1`,
      [
        claim.materialId,
        statusJson('done'),
        encodeJson(stored, 'owner material extraction result'),
        cacheKey,
      ],
    );
    return 'published' as const;
  });
}

/**
 * The latest successful extraction stored under `cacheKey` by another source
 * of the same owner as `sourceId` (its owner now, after any claim), read
 * without a lock: a candidate only. A hit is re-checked under lock when it is
 * published ({@link publishOwnerMaterialExtraction}).
 */
export async function findOwnerExtractionCacheHit(
  queryable: Queryable,
  sourceId: string,
  cacheKey: string,
): Promise<{ materialId: string; result: OwnerExtractionResult } | null> {
  const found = await queryable.query<{ id: string; extraction_result: unknown }>(
    `SELECT donor.id, donor.extraction_result
       FROM owner_material AS source
       JOIN owner_material AS donor ON donor.owner_id = source.owner_id
      WHERE source.id = $1 AND donor.extraction_cache_key = $2 AND donor.id <> source.id
        AND donor.kind = 'source' AND donor.deleted_at IS NULL
        AND (donor.extraction->>'status') = 'done' AND donor.extraction_result IS NOT NULL
      ORDER BY donor.created_at DESC, donor.id
      LIMIT 1`,
    [sourceId, cacheKey],
  );
  const row = found.rows[0];
  return row
    ? { materialId: row.id, result: row.extraction_result as OwnerExtractionResult }
    : null;
}
