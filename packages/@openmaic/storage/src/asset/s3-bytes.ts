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
import type { AssetByteStore, AssetSignedReadHeaders } from './byte-store.js';

interface S3ObjectInput {
  Bucket: string;
  Key: string;
}

interface S3PutObjectInput extends S3ObjectInput {
  Body: Uint8Array;
  ContentLength: number;
}

interface S3GetObjectInput extends S3ObjectInput {
  ResponseContentType?: string;
  ResponseContentDisposition?: string;
  ResponseCacheControl?: string;
}

interface S3GetObjectOutput {
  Body?: { transformToByteArray(): Promise<Uint8Array> };
}

export interface S3AssetByteStoreClient {
  send(command: unknown): Promise<unknown>;
}

export interface S3AssetByteStoreCommands {
  put(input: S3PutObjectInput): unknown;
  get(input: S3GetObjectInput): unknown;
  delete(input: S3ObjectInput): unknown;
}

/**
 * URL signing from the same SDK implementation as the client and commands.
 *
 * The seam mirrors `commands`: a test double binds its own signer, and a
 * deployment that never enables indirect egress never resolves the optional
 * presigner package at all.
 */
export interface S3AssetByteStoreSigner {
  sign(client: S3AssetByteStoreClient, command: unknown, expiresInSeconds: number): Promise<string>;
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
  /**
   * The URL signer, from the same SDK implementation as the client.
   *
   * Optional exactly as `commands` is: omitted, the store resolves
   * `@aws-sdk/s3-request-presigner` on its first `signReadUrl` call, and a
   * store that is never asked to sign never resolves it.
   */
  signer?: S3AssetByteStoreSigner;
  /** Bucket dedicated to content-hash-named asset objects. */
  bucket: string;
}

const AWS_S3_CLIENT_PACKAGE = '@aws-sdk/client-s3';
const AWS_S3_PRESIGNER_PACKAGE = '@aws-sdk/s3-request-presigner';

interface S3Sdk {
  S3Client: new (options: Record<string, never>) => S3AssetByteStoreClient;
  PutObjectCommand: new (input: S3PutObjectInput) => unknown;
  GetObjectCommand: new (input: S3GetObjectInput) => unknown;
  DeleteObjectCommand: new (input: S3ObjectInput) => unknown;
}

interface S3PresignerSdk {
  getSignedUrl(
    client: S3AssetByteStoreClient,
    command: unknown,
    options: { expiresIn: number },
  ): Promise<string>;
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

/**
 * Resolve the optional request presigner from this package's resolution scope.
 *
 * Separate from `importS3Sdk` on purpose: the presigner is a second optional
 * peer, and only `signReadUrl` needs it. Byte writes, reads, and deletes --
 * including every deployment that never enables indirect egress -- must not
 * resolve it, so this function is reached only from the signing path below.
 */
async function importS3Presigner(): Promise<S3PresignerSdk> {
  return (await import(/* webpackIgnore: true */ AWS_S3_PRESIGNER_PACKAGE)) as S3PresignerSdk;
}

function sdkCommands(sdk: S3Sdk): S3AssetByteStoreCommands {
  return {
    put: (input) => new sdk.PutObjectCommand(input),
    get: (input) => new sdk.GetObjectCommand(input),
    delete: (input) => new sdk.DeleteObjectCommand(input),
  };
}

function sdkSigner(sdk: S3PresignerSdk): S3AssetByteStoreSigner {
  return {
    sign: (client, command, expiresInSeconds) =>
      sdk.getSignedUrl(client, command, { expiresIn: expiresInSeconds }),
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

function missingPresigner(error: unknown): Error {
  return new Error(
    `@openmaic/storage: signing S3 asset read URLs requires the optional ${AWS_S3_PRESIGNER_PACKAGE} ` +
      'dependency, which could not be resolved. Install it, or construct the store with ' +
      'an explicit `signer`.',
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
  /** Same resolution discipline as the commands: lazy, cached, never poisoning. */
  private resolvedSigner: S3AssetByteStoreSigner | undefined;
  private pendingSigner: Promise<S3AssetByteStoreSigner> | undefined;

  constructor(options: S3AssetByteStoreOptions) {
    this.client = options.client;
    this.resolvedCommands = options.commands;
    this.resolvedSigner = options.signer;
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

  /**
   * The signer, resolved on first signing use and cached afterwards.
   *
   * Same rules as the commands above: never at module evaluation, never in the
   * constructor, and never on a byte operation -- only `signReadUrl` reaches
   * the optional presigner peer, so a deployment that keeps direct egress
   * (the default) never resolves it. A failed resolution is not cached.
   */
  private signer(): Promise<S3AssetByteStoreSigner> {
    const resolved = this.resolvedSigner;
    if (resolved) return Promise.resolve(resolved);
    if (this.pendingSigner) return this.pendingSigner;
    const pending = importS3Presigner().then(
      (sdk) => {
        const signer = sdkSigner(sdk);
        this.resolvedSigner = signer;
        this.pendingSigner = undefined;
        return signer;
      },
      (error: unknown) => {
        if (this.pendingSigner === pending) this.pendingSigner = undefined;
        throw missingPresigner(error);
      },
    );
    this.pendingSigner = pending;
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

  /**
   * Mint a short-lived presigned GET URL for the object under a hash.
   *
   * The response-header overrides are signed into the URL, so the object
   * store's own response carries the relabelled media type, the fixed
   * disposition, and the read route's cache posture exactly as the direct
   * byte response would have. Signing is local credential arithmetic: no
   * request is made, and a hash naming no object signs exactly as readily as
   * one that does -- the registry read above has already established both
   * ownership and existence, and a probing store would make the cost of a
   * read vary with prior presence.
   */
  async signReadUrl(
    hash: ContentHash,
    headers: AssetSignedReadHeaders,
  ): Promise<string | undefined> {
    // Resolved outside the try for the same reason as the write path: a
    // missing optional dependency reports itself by name rather than being
    // flattened into an opaque "sign failed".
    const commands = await this.commands();
    let signer: S3AssetByteStoreSigner;
    try {
      signer = await this.signer();
    } catch {
      // An unresolvable optional presigner means this layer cannot sign after
      // all, which is a capability answer, not a failed read: decline, and the
      // caller falls back to serving the bytes directly.
      return undefined;
    }
    try {
      return await signer.sign(
        this.client,
        commands.get({
          Bucket: this.bucket,
          Key: hash,
          ResponseContentType: headers.contentType,
          ...(headers.contentDisposition === undefined
            ? {}
            : { ResponseContentDisposition: headers.contentDisposition }),
          ResponseCacheControl: headers.cacheControl,
        }),
        headers.expiresInSeconds,
      );
    } catch {
      throw s3Failure('sign');
    }
  }
}

export type { AssetByteStore, AssetSignedReadHeaders } from './byte-store.js';
