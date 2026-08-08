/**
 * S3 byte storage for the server asset registry.
 *
 * Each object key is exactly its content hash. A crash after PUT and before the
 * registry row is committed leaves an object that reference counting cannot
 * see. Configure a bucket lifecycle policy for such old objects, or
 * periodically reconcile bucket keys against `asset_blobs`. Hash-named orphans
 * are harmless and a later write of the same bytes overwrites them
 * idempotently; no pending-object state is required.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { ContentHash } from './blob.js';
import type { AssetByteStore } from './byte-store.js';

export interface S3AssetByteStoreOptions {
  /** An AWS SDK v3 S3 client, or a compatible client used by a test double. */
  client: Pick<S3Client, 'send'>;
  /** Bucket dedicated to content-hash-named asset objects. */
  bucket: string;
}

function s3Failure(operation: string): Error {
  return new Error(`@openmaic/storage: S3 asset byte ${operation} failed`);
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export class S3AssetByteStore implements AssetByteStore {
  private readonly client: Pick<S3Client, 'send'>;
  private readonly bucket: string;

  constructor(options: S3AssetByteStoreOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
  }

  async write(hash: ContentHash, bytes: Uint8Array): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: hash,
          Body: bytes,
          ContentLength: bytes.byteLength,
        }),
      );
    } catch {
      throw s3Failure('write');
    }
  }

  async read(hash: ContentHash): Promise<Uint8Array | null> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: hash }),
      );
      if (!output.Body) throw s3Failure('read');
      return Uint8Array.from(await output.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw s3Failure('read');
    }
  }

  async delete(hash: ContentHash): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: hash }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw s3Failure('delete');
    }
  }
}

export type { AssetByteStore } from './byte-store.js';
