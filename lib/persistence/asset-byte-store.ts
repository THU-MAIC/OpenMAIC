/**
 * Which byte layer the server asset registry stores bytes in.
 *
 * Shared rather than owned by the persistence route, because the offline
 * collector must reclaim through the *same* byte layer the route wrote
 * through. A collector holding a PostgreSQL byte store while the route writes
 * to S3 would drop the blob row and leave the object behind forever, which is
 * the leak the collector exists to close.
 */
import { PgAssetByteStore } from '@openmaic/storage/asset/pg-bytes';
import type { AssetByteStore, Queryable } from '@openmaic/storage/asset/pg';

const S3_RESERVED_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'];
const S3_RESERVED_SUFFIXES = ['-s3alias', '--ol-s3', '.mrap', '--x-s3', '--table-s3'];

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
