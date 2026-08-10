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
  /**
   * Command factories from the same SDK implementation as the client.
   *
   * Optional. Omitted, the store resolves the AWS SDK's own command
   * constructors on its first method call, so `{ client, bucket }` — the shape
   * this store has always accepted — keeps working. Supply this to bind a test
   * double, or an SDK copy other than the one this package resolves.
   */
  commands?: S3AssetByteStoreCommands;
  /** Bucket dedicated to content-hash-named asset objects. */
  bucket: string;
}

const AWS_S3_CLIENT_PACKAGE = '@aws-sdk/client-s3';

interface S3Sdk {
  S3Client: new (options: Record<string, never>) => S3AssetByteStoreClient;
  PutObjectCommand: new (input: S3PutObjectInput) => unknown;
  GetObjectCommand: new (input: S3ObjectInput) => unknown;
  DeleteObjectCommand: new (input: S3ObjectInput) => unknown;
}

/**
 * Resolve the optional AWS SDK from this package's resolution scope.
 *
 * The ignored native import is deliberate: consumers that do not select S3
 * neither resolve nor bundle the optional peer dependency. Every caller of this
 * function is therefore reached only from an `await`ed code path, never from
 * module evaluation or a constructor.
 */
async function importS3Sdk(): Promise<S3Sdk> {
  return (await import(/* webpackIgnore: true */ AWS_S3_CLIENT_PACKAGE)) as S3Sdk;
}

function sdkCommands(sdk: S3Sdk): S3AssetByteStoreCommands {
  return {
    put: (input) => new sdk.PutObjectCommand(input),
    get: (input) => new sdk.GetObjectCommand(input),
    delete: (input) => new sdk.DeleteObjectCommand(input),
  };
}

function missingSdk(error: unknown): Error {
  return new Error(
    `@openmaic/storage: the S3 asset byte store requires the optional ${AWS_S3_CLIENT_PACKAGE} ` +
      'dependency, which could not be resolved. Install it, or construct the store with ' +
      'explicit `commands`.',
    { cause: error },
  );
}

/**
 * Build a store bound to the optional AWS SDK, resolving it now.
 *
 * The store this returns already carries its commands, so the lazy path below
 * never runs for it. A host that wants resolution deferred to first use can
 * construct `new S3AssetByteStore({ client, bucket })` itself instead.
 */
export async function loadS3AssetByteStore(bucket: string): Promise<AssetByteStore> {
  try {
    const sdk = await importS3Sdk();
    return new S3AssetByteStore({
      bucket,
      client: new sdk.S3Client({}),
      commands: sdkCommands(sdk),
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
  private readonly bucket: string;
  /** Set once resolved, whether supplied by the caller or loaded from the SDK. */
  private resolvedCommands: S3AssetByteStoreCommands | undefined;
  private pendingCommands: Promise<S3AssetByteStoreCommands> | undefined;

  constructor(options: S3AssetByteStoreOptions) {
    this.client = options.client;
    this.resolvedCommands = options.commands;
    this.bucket = options.bucket;
  }

  /**
   * The command constructors, resolved on first use and cached afterwards.
   *
   * Resolution is deliberately not done in the constructor. Importing this
   * module must not reach the optional peer dependency, and neither must
   * constructing a store: a deployment that never stores a byte in S3 must
   * never resolve the SDK. Only an actual `write` / `read` / `delete` does.
   *
   * A failed resolution is not cached, so a store built before the dependency
   * was installed starts working once it is, rather than staying poisoned for
   * the life of the process.
   */
  private commands(): Promise<S3AssetByteStoreCommands> {
    const resolved = this.resolvedCommands;
    if (resolved) return Promise.resolve(resolved);
    if (this.pendingCommands) return this.pendingCommands;
    const pending = importS3Sdk().then(
      (sdk) => {
        const commands = sdkCommands(sdk);
        this.resolvedCommands = commands;
        this.pendingCommands = undefined;
        return commands;
      },
      (error: unknown) => {
        if (this.pendingCommands === pending) this.pendingCommands = undefined;
        throw missingSdk(error);
      },
    );
    this.pendingCommands = pending;
    return pending;
  }

  async write(hash: ContentHash, bytes: Uint8Array): Promise<void> {
    // Resolved outside the try so a missing optional dependency reports itself
    // by name instead of being flattened into an opaque "write failed".
    const commands = await this.commands();
    try {
      await this.client.send(
        commands.put({
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
    const commands = await this.commands();
    try {
      const output = (await this.client.send(
        commands.get({ Bucket: this.bucket, Key: hash }),
      )) as S3GetObjectOutput;
      if (!output.Body) throw s3Failure('read');
      return Uint8Array.from(await output.Body.transformToByteArray());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw s3Failure('read');
    }
  }

  async delete(hash: ContentHash): Promise<void> {
    const commands = await this.commands();
    try {
      await this.client.send(commands.delete({ Bucket: this.bucket, Key: hash }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw s3Failure('delete');
    }
  }
}

export type { AssetByteStore } from './byte-store.js';
