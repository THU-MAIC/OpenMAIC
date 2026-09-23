/**
 * Per-owner asset partitions over one server asset registry.
 *
 * Every allocation is stored under a principal derived from the request owner
 * ({@link assetPrincipalForOwner}), so quota is accounted per owner and the
 * store's own per-principal checks make replace and delete owner-only.
 *
 * Reads stay capability-by-id, because a course is readable by id and its
 * viewers must be able to load the media it names. The store itself only
 * answers a principal's own entries, so {@link createOwnerAssetStore} adds one
 * rule on top of it: an entry held by another owner is readable when it is
 * committed and a live (not tombstoned) course references it. A pending
 * allocation stays private to its owner until a document write claims it.
 *
 * Entries written before per-owner partitions existed all live under the one
 * deployment-wide principal {@link LEGACY_SHARED_ASSET_PRINCIPAL}:
 *
 * - They stay readable by id to every owner, exactly as before.
 * - They can be replaced or deleted by an owner who owns every course that
 *   references them (at least one). Nobody else can prove a claim on them, so
 *   nobody else may mutate them.
 * - Everything else about them is the server lifecycle's: deleting or editing
 *   the referencing course withdraws its references and the collector
 *   reclaims the entry, as it always did.
 *
 * They are never re-keyed to an owner: quota for them stays with the legacy
 * partition, and no client-supplied identity is involved at any point.
 */
import {
  AssetNotFoundError,
  type AssetIdentity,
  type AssetBytes,
  type AssetIndirectRead,
  type AssetIndirectReadRequest,
  type AssetPrincipal,
  type AssetStore,
} from '@openmaic/storage';
import type { AssetMeta, AssetRef, BinaryBlob } from '@openmaic/dsl';

/**
 * The single asset partition every caller shared before per-owner partitions.
 * It has no `:` in it, so no {@link assetPrincipalForOwner} key can equal it —
 * not even for an owner whose id is literally `shared`.
 */
export const LEGACY_SHARED_ASSET_PRINCIPAL = 'shared';

const OWNER_ASSET_PRINCIPAL_PREFIX = 'owner:';

/** The asset principal of an owner. Derived server-side from a resolved owner id only. */
export function assetPrincipalForOwner(ownerId: string): AssetPrincipal {
  if (typeof ownerId !== 'string' || ownerId === '') {
    throw new Error('assetPrincipalForOwner requires a resolved owner id');
  }
  return { key: `${OWNER_ASSET_PRINCIPAL_PREFIX}${ownerId}`, learnerKey: ownerId };
}

/** The query surface the read and mutation rules need. */
export interface OwnerAssetQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** An id PostgreSQL cannot bind as text cannot name a row, so it is a miss. */
function isQueryableId(value: string): boolean {
  return typeof value === 'string' && !value.includes('\0') && !LONE_SURROGATE.test(value);
}

/**
 * The principal to read `ref` under when the caller's own partition missed:
 * a legacy shared entry, or another owner's committed entry that a live course
 * references. `undefined` when the caller may not read it.
 */
async function foreignReadablePrincipal(
  queryable: OwnerAssetQueryable,
  ref: string,
  callerKey: string,
): Promise<string | undefined> {
  if (!isQueryableId(ref)) return undefined;
  const result = await queryable.query(
    `SELECT e.principal
       FROM asset_entries e
      WHERE e.id = $1
        AND e.principal <> $2
        AND (
          e.principal = $3
          OR (
            e.committed_at IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM document_asset_refs r
                JOIN stage_meta m ON m.stage_id = r.stage_id
               WHERE r.asset_id = e.id
                 AND m.deleted_at IS NULL
            )
          )
        )`,
    [ref, callerKey, LEGACY_SHARED_ASSET_PRINCIPAL],
  );
  const row = result.rows[0] as { principal?: unknown } | undefined;
  return typeof row?.principal === 'string' ? row.principal : undefined;
}

/**
 * The principal a mutation of `ref` runs under: the caller's own when the entry
 * is theirs, the legacy partition when the entry is legacy and every course
 * referencing it (at least one) belongs to `ownerId`, otherwise `undefined`.
 */
async function mutablePrincipal(
  queryable: OwnerAssetQueryable,
  ref: string,
  caller: AssetPrincipal,
  ownerId: string,
): Promise<AssetPrincipal | undefined> {
  if (!isQueryableId(ref)) return undefined;
  const entry = await queryable.query('SELECT principal FROM asset_entries WHERE id = $1', [ref]);
  const principal = (entry.rows[0] as { principal?: unknown } | undefined)?.principal;
  if (principal === caller.key) return caller;
  if (principal !== LEGACY_SHARED_ASSET_PRINCIPAL) return undefined;
  const refs = await queryable.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE m.owner_id = $2)::int AS owned
       FROM document_asset_refs r
       LEFT JOIN stage_meta m ON m.stage_id = r.stage_id
      WHERE r.asset_id = $1`,
    [ref, ownerId],
  );
  const counts = refs.rows[0] as { total?: unknown; owned?: unknown } | undefined;
  const total = Number(counts?.total ?? 0);
  const owned = Number(counts?.owned ?? 0);
  return total > 0 && owned === total ? { key: LEGACY_SHARED_ASSET_PRINCIPAL } : undefined;
}

export interface OwnerAssetStoreOptions {
  /** The owner every principal passed to this store was derived from. */
  ownerId: string;
  queryable: OwnerAssetQueryable;
}

/**
 * Wrap the registry for one request owner with the read and mutation rules
 * above. Allocation goes to the principal the caller passes (the owner's own);
 * reads fall back to the foreign-read rule only after the caller's own
 * partition missed, so an owner's own reads cost no extra query.
 */
export function createOwnerAssetStore(
  inner: AssetStore,
  options: OwnerAssetStoreOptions,
): AssetStore {
  const { ownerId, queryable } = options;

  async function readWithFallback<T>(
    principal: AssetPrincipal,
    ref: AssetRef,
    read: (principal: AssetPrincipal) => Promise<T | null>,
  ): Promise<T | null> {
    const own = await read(principal);
    if (own !== null) return own;
    const foreign = await foreignReadablePrincipal(queryable, ref, principal.key);
    return foreign === undefined ? null : read({ key: foreign });
  }

  const store: AssetStore = {
    put: (principal: AssetPrincipal, data: BinaryBlob, meta?: AssetMeta) =>
      inner.put(principal, data, meta),
    identify: (principal: AssetPrincipal, ref: AssetRef): Promise<AssetIdentity | null> =>
      readWithFallback(principal, ref, (as) => inner.identify(as, ref)),
    resolve: (principal: AssetPrincipal, ref: AssetRef): Promise<AssetBytes | null> =>
      readWithFallback(principal, ref, (as) => inner.resolve(as, ref)),
    async remove(principal: AssetPrincipal, ref: AssetRef): Promise<void> {
      const as = await mutablePrincipal(queryable, ref, principal, ownerId);
      // Another owner's id is the same silent no-op as an unknown id.
      if (as !== undefined) await inner.remove(as, ref);
    },
    async replace(principal, ref, data, meta) {
      const as = await mutablePrincipal(queryable, ref, principal, ownerId);
      if (as === undefined) throw new AssetNotFoundError();
      return inner.replace(as, ref, data, meta);
    },
  };
  if (typeof inner.resolveIndirect === 'function') {
    const resolveIndirect = inner.resolveIndirect.bind(inner);
    store.resolveIndirect = async (
      principal: AssetPrincipal,
      ref: AssetRef,
      request: AssetIndirectReadRequest,
    ): Promise<AssetIndirectRead | null | undefined> => {
      const own = await resolveIndirect(principal, ref, request);
      // `undefined` is "this byte layer cannot sign", independent of the entry.
      if (own !== null) return own;
      const foreign = await foreignReadablePrincipal(queryable, ref, principal.key);
      return foreign === undefined ? null : resolveIndirect({ key: foreign }, ref, request);
    };
  }
  return store;
}
