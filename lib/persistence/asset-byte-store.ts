/**
 * Which byte layer the server asset registry stores bytes in.
 *
 * Shared rather than owned by the persistence route, because the offline
 * collector must reclaim through the *same* byte layer the route wrote
 * through. A collector holding a PostgreSQL byte store while the route writes
 * to S3 would drop the blob row and leave the object behind forever, which is
 * the leak the collector exists to close.
 *
 * The two entry points below are the only ones either side uses:
 * {@link configuredLazyAssetByteStore} for the persistence provider and
 * {@link resolveConfiguredAssetByteStore} for the collector. Both read the one
 * host registration (`configureAssetByteStore`, in
 * `lib/server/persistence-hooks/`) and otherwise fall back to the built-in
 * choice, S3 when `ASSET_S3_BUCKET` is set and the PostgreSQL column when not.
 */
import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import type { AssetByteStore, Queryable } from '@openmaic/storage/asset/pg';

import { getAssetByteStoreRegistration } from '@/lib/server/persistence-hooks/registry';
import type { AssetByteStoreRegistration } from '@/lib/server/persistence-hooks/types';

// Tracing anchors for the standalone build. The store implementations below
// reach both packages through deliberately untraced dynamic imports (they
// are optional peers of the storage package), so without a literal reference
// here the shipped image cannot resolve them. The thunks are never called:
// module resolution still happens only on first S3 use, and both packages
// are server-external, so nothing is bundled either.
const _assetSdkTraceAnchors = {
  client: () => import('@aws-sdk/client-s3'),
  presigner: () => import('@aws-sdk/s3-request-presigner'),
};
void _assetSdkTraceAnchors;

const S3_RESERVED_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'];
const S3_RESERVED_SUFFIXES = ['-s3alias', '--ol-s3', '.mrap', '--x-s3', '--table-s3'];

/**
 * The no-bucket byte layer widened with the transaction-pinned methods the
 * registry and the collector duck-type on (`writeWith` / `readWith` /
 * `deleteWith`). Without a bucket the layer is statically `PgAssetByteStore`,
 * so the methods are always present; the widening exists so the wrapper's
 * forwarding is type-checked against the real implementations rather than
 * declared by hand.
 */
interface PgForwardedByteStore extends AssetByteStore {
  writeWith: PgAssetByteStore['writeWith'];
  readWith: PgAssetByteStore['readWith'];
  deleteWith: PgAssetByteStore['deleteWith'];
}

/**
 * ASSET_S3_BUCKET: a valid bucket name opts asset bytes into S3. The optional
 * AWS SDK owns its standard region, credential, and endpoint configuration;
 * nothing here reads an AWS environment variable itself.
 *
 * Validated eagerly and separately from store construction so a caller can
 * reject a malformed name before it opens a database connection or resolves
 * the optional SDK.
 */
export function configuredS3Bucket(value: string | undefined): string | undefined {
  const bucket = value?.trim();
  if (!bucket) return undefined;
  const invalid =
    bucket.length < 3 ||
    bucket.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) ||
    bucket.includes('..') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket) ||
    S3_RESERVED_PREFIXES.some((prefix) => bucket.startsWith(prefix)) ||
    S3_RESERVED_SUFFIXES.some((suffix) => bucket.endsWith(suffix));
  if (invalid) {
    throw new Error(
      'Invalid ASSET_S3_BUCKET: expected a valid Amazon S3 general purpose bucket name',
    );
  }
  return bucket;
}

/**
 * The byte store for a configured bucket, or the PostgreSQL byte layer.
 *
 * This is the only optional import path. The storage package owns both the SDK
 * dependency and its ignored native import, so resolution happens from the
 * package that declares the peer rather than from this app — and only when a
 * bucket is actually configured.
 */
export async function createAssetByteStore(
  bucket: string | undefined,
  queryable: Queryable,
): Promise<AssetByteStore> {
  if (!bucket) return new PgAssetByteStore(queryable);
  const storage = await import('@openmaic/storage/asset/s3-bytes');
  return storage.loadS3AssetByteStore(bucket);
}

/**
 * A byte store whose construction is deferred to first use.
 *
 * The asset backend is optional, so its configuration must not gate the rest
 * of persistence. Awaiting createAssetByteStore during handler initialization
 * would let an invalid ASSET_S3_BUCKET, or an AWS SDK that cannot be resolved,
 * reject the shared handler and take document and runtime traffic down with
 * it. With this wrapper, installed instead, handler initialization never
 * touches asset configuration: a misconfiguration fails asset requests and
 * only asset requests. A failed construction is not cached, so the next asset
 * request retries — the same no-poisoned-singleton rule the route applies to
 * its own initialization.
 */
export function lazyAssetByteStore(
  bucketValue: string | undefined,
  queryable: Queryable,
): AssetByteStore {
  let pending: Promise<AssetByteStore> | undefined;
  const resolve = (): Promise<AssetByteStore> =>
    (pending ??= createAssetByteStore(configuredS3Bucket(bucketValue), queryable).catch(
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    ));
  const base = {
    write: async (hash, bytes) => (await resolve()).write(hash, bytes),
    read: async (hash) => (await resolve()).read(hash),
    delete: async (hash) => (await resolve()).delete(hash),
  } satisfies AssetByteStore;
  // The PostgreSQL byte column can never sign, and advertising the method
  // anyway would make resolveIndirect take its ownership query and blob-row
  // lock before declining, then repeat them in resolve -- on every cold GET.
  // With no bucket configured the layer is known now, so the method is
  // simply absent. With a bucket, lazy validation is preserved: the wrapper
  // answers `undefined` when the resolved layer turns out not to sign.
  if (!bucketValue?.trim()) {
    // No bucket means the layer is statically PgAssetByteStore, whose bytes
    // live in the registry's own PostgreSQL. Its transaction-pinned
    // writeWith/readWith/deleteWith MUST be forwarded: without them the
    // registry's coordinatedWrite duck-type check fails and it falls back to
    // the plain write on the byte store's own pooled connection, which blocks
    // forever on the blob-row lock the registry transaction just took -- the
    // self-deadlock. The layer is known now, so the methods are always
    // present; nothing here is probed lazily.
    const forwarded: PgForwardedByteStore = {
      ...base,
      writeWith: async (queryable, hash, bytes) =>
        ((await resolve()) as PgAssetByteStore).writeWith(queryable, hash, bytes),
      readWith: async (queryable, hash) =>
        ((await resolve()) as PgAssetByteStore).readWith(queryable, hash),
      deleteWith: async (queryable, hash) =>
        ((await resolve()) as PgAssetByteStore).deleteWith(queryable, hash),
    };
    return forwarded;
  }
  return {
    ...base,
    // S3 objects never live in the registry's database, so the registry may
    // run the plain write inside its transaction (see
    // AssetByteStore.writesOutsideRegistryDatabase). S3 has no transactional
    // writer, so nothing is forwarded here, exactly as before.
    writesOutsideRegistryDatabase: true as const,
    signReadUrl: async (hash, headers) => {
      const store = await resolve();
      return typeof store.signReadUrl === 'function' ? store.signReadUrl(hash, headers) : undefined;
    },
  };
}

/**
 * Check what a host factory built before anything uses it. A store that is not
 * an AssetByteStore, or that does not declare its bytes outside the registry
 * database, fails here -- on the asset request or collector pass that built it
 * -- with the registration named, instead of misbehaving later.
 *
 * `writesOutsideRegistryDatabase` is the host's assertion, and it is trusted:
 * core cannot see where a store writes. A store that declares it and still
 * writes through the registry's own PostgreSQL can deadlock on the blob-row
 * lock the registry transaction holds. A host byte layer inside the registry
 * database (one that forwards transaction-pinned `writeWith` / `deleteWith`)
 * is not accepted: the lazy wrapper would have to know those methods before
 * building the store, and that layer is exactly the built-in default.
 */
function checkedRegisteredStore(
  registration: AssetByteStoreRegistration,
  store: AssetByteStore,
): AssetByteStore {
  const label = `Asset byte store ${registration.name}`;
  if (
    !store ||
    typeof store !== 'object' ||
    typeof store.write !== 'function' ||
    typeof store.read !== 'function' ||
    typeof store.delete !== 'function'
  ) {
    throw new Error(`${label} returned something that is not an AssetByteStore`);
  }
  if (store.writesOutsideRegistryDatabase !== true) {
    throw new Error(
      `${label} must declare writesOutsideRegistryDatabase: true. A configured byte store keeps ` +
        'its bytes outside the registry database; the in-database layer is the built-in default.',
    );
  }
  if (registration.signsReadUrls === true && typeof store.signReadUrl !== 'function') {
    // Not fatal, and deliberately so: signing is only an egress optimization.
    // Byte reads fall back to direct bytes (see lazyRegisteredByteStore) and
    // the collector never signs, so refusing the store here would take
    // uploads and reclamation down over a missing optimization.
    console.warn(
      `${label} declares signsReadUrls but has no signReadUrl(); asset reads use direct bytes.`,
    );
  }
  return store;
}

async function createRegisteredStore(
  registration: AssetByteStoreRegistration,
  queryable: Queryable,
): Promise<AssetByteStore> {
  return checkedRegisteredStore(registration, await registration.create({ queryable }));
}

/**
 * A host store behind the same deferred construction as
 * {@link lazyAssetByteStore}, for the same reason: its failure must reach
 * asset requests only, and be retried. Its shape is known without building
 * it -- outside the registry database, signing exactly when declared -- so
 * the wrapper advertises precisely that and nothing is probed lazily.
 */
function lazyRegisteredByteStore(
  registration: AssetByteStoreRegistration,
  queryable: Queryable,
): AssetByteStore {
  let pending: Promise<AssetByteStore> | undefined;
  const resolve = (): Promise<AssetByteStore> =>
    (pending ??= createRegisteredStore(registration, queryable).catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
  return {
    write: async (hash, bytes) => (await resolve()).write(hash, bytes),
    read: async (hash) => (await resolve()).read(hash),
    delete: async (hash) => (await resolve()).delete(hash),
    writesOutsideRegistryDatabase: true as const,
    ...(registration.signsReadUrls === true
      ? {
          // Degrades like the built-in wrapper: a store that turns out not to
          // sign answers `undefined`, and the read falls back to direct bytes.
          signReadUrl: async (hash, headers) => {
            const store = await resolve();
            return typeof store.signReadUrl === 'function'
              ? store.signReadUrl(hash, headers)
              : undefined;
          },
        }
      : {}),
  } satisfies AssetByteStore;
}

/** The built-in choice's one setting, read per call so a changed value is observed. */
function builtInBucketSetting(): string | undefined {
  return process.env.ASSET_S3_BUCKET;
}

/** The persistence provider's byte store: the host's, else the built-in choice. */
export function configuredLazyAssetByteStore(queryable: Queryable): AssetByteStore {
  const registration = getAssetByteStoreRegistration();
  return registration
    ? lazyRegisteredByteStore(registration, queryable)
    : lazyAssetByteStore(builtInBucketSetting(), queryable);
}

/** The collector's byte store, built now: the host's, else the built-in choice. */
export async function resolveConfiguredAssetByteStore(
  queryable: Queryable,
): Promise<AssetByteStore> {
  const registration = getAssetByteStoreRegistration();
  return registration
    ? createRegisteredStore(registration, queryable)
    : createAssetByteStore(configuredS3Bucket(builtInBucketSetting()), queryable);
}
