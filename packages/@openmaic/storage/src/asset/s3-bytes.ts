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
import type { ContentHash } from './blob.js';
import type { AssetByteStore } from './byte-store.js';

interface S3ObjectInput {
  Bucket: string;
  Key: string;
}

interface S3PutObjectInput extends S3ObjectInput {
  Body: Uint8Array;
  ContentLength: number;
}

interface S3GetObjectOutput {
  Body?: { transformToByteArray(): Promise<Uint8Array> };
}

export interface S3AssetByteStoreClient {
  send(command: unknown): Promise<unknown>;
}

export interface S3AssetByteStoreCommands {
  put(input: S3PutObjectInput): unknown;
  get(input: S3ObjectInput): unknown;
  delete(input: S3ObjectInput): unknown;
}

export interface S3AssetByteStoreOptions {
  /** An AWS SDK v3 S3 client, or a compatible client used by a test double. */
  client: S3AssetByteStoreClient;
  /** Command factories from the same SDK implementation as the client. */
  commands: S3AssetByteStoreCommands;
  /** Bucket dedicated to content-hash-named asset objects. */
  bucket: string;
}

const AWS_S3_CLIENT_PACKAGE = '@aws-sdk/client-s3';

/**
 * Load the optional AWS SDK from this package's resolution scope.
 *
 * The ignored native import is deliberate: consumers that do not select S3
 * neither resolve nor bundle the optional peer dependency.
 */
export async function loadS3AssetByteStore(bucket: string): Promise<AssetByteStore> {
  try {
    const sdk = (await import(/* webpackIgnore: true */ AWS_S3_CLIENT_PACKAGE)) as {
      S3Client: new (options: Record<string, never>) => S3AssetByteStoreClient;
      PutObjectCommand: new (input: S3PutObjectInput) => unknown;
      GetObjectCommand: new (input: S3ObjectInput) => unknown;
      DeleteObjectCommand: new (input: S3ObjectInput) => unknown;
    };
    return new S3AssetByteStore({
      bucket,
      client: new sdk.S3Client({}),
      commands: {
        put: (input) => new sdk.PutObjectCommand(input),
        get: (input) => new sdk.GetObjectCommand(input),
        delete: (input) => new sdk.DeleteObjectCommand(input),
      },
    });
  } catch (error) {
    throw new Error('@openmaic/storage: S3 asset byte store initialization failed', {
      cause: error,
    });
  }
}

function s3Failure(operation: string): Error {
  return new Error(`@openmaic/storage: S3 asset byte ${operation} failed`);
}

/**
 * Whether an error means *this key* is absent, and nothing else.
 *
 * Deliberately narrow. A bare `404` also covers `NoSuchBucket`, a misdirected
 * endpoint, and a revoked access point — conditions under which the bytes very
 * much still exist. Reporting one of those as an absent object walks into the
 * failure the contract warns about for `401`: the caller reads "deleted",
 * clears a live registry reference, and a storage outage becomes real data
 * loss. Only key-absent codes map to a miss; everything else propagates and
 * surfaces as `500 INTERNAL_ERROR`.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.code === 'NoSuchKey'
  );
}

export class S3AssetByteStore implements AssetByteStore {
  private readonly client: S3AssetByteStoreClient;
  private readonly commands: S3AssetByteStoreCommands;
  private readonly bucket: string;

  constructor(options: S3AssetByteStoreOptions) {
    this.client = options.client;
    this.commands = options.commands;
    this.bucket = options.bucket;
  }

  async write(hash: ContentHash, bytes: Uint8Array): Promise<void> {
    try {
      await this.client.send(
        this.commands.put({
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
      const output = (await this.client.send(
        this.commands.get({ Bucket: this.bucket, Key: hash }),
      )) as S3GetObjectOutput;
      if (!output.Body) throw s3Failure('read');
      return Uint8Array.from(await output.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw s3Failure('read');
    }
  }

  async delete(hash: ContentHash): Promise<void> {
    try {
      await this.client.send(this.commands.delete({ Bucket: this.bucket, Key: hash }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw s3Failure('delete');
    }
  }
}

export type { AssetByteStore } from './byte-store.js';
