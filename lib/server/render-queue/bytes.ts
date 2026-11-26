/**
 * Where a render job's archive and MP4 are kept: 8 MiB parts in the job's own
 * namespace of the configured asset byte store, each under its content hash,
 * with the list of parts on the job row. The layout of sandbox checkpoints
 * (`lib/server/sandbox/checkpoint-storage.ts`): one part in memory at a time,
 * and the same code whether the bytes land in S3, a host's object store, or
 * PostgreSQL (`asset_prefixed_bytes`).
 */
import { createHash } from 'node:crypto';
import type { AssetByteStore } from '@openmaic/storage/asset/pg';

import { resolveConfiguredAssetByteStore } from '@/lib/persistence/asset-byte-store';

import { renderQueuePersistence, type Queryable, type RenderJobPart } from './store';

export const RENDER_PART_BYTES = 8 * 1024 ** 2;

type Hash = Parameters<AssetByteStore['write']>[0];

/** The byte store has no isolated namespaces (a host store without `withPrefix`). */
export class RenderQueueStorageUnavailableError extends Error {
  constructor() {
    super(
      'The durable render queue needs an asset byte store with isolated-prefix support (withPrefix).',
    );
    this.name = 'RenderQueueStorageUnavailableError';
  }
}

/** A stored part is missing or does not match its recorded hash or size. */
export class RenderPartCorruptError extends Error {
  constructor() {
    super('A stored render part is missing or does not match its checksum');
    this.name = 'RenderPartCorruptError';
  }
}

/** The source is larger than the bound it was stored under. */
export class RenderPartsTooLargeError extends Error {
  constructor() {
    super('The render payload exceeds its size limit');
    this.name = 'RenderPartsTooLargeError';
  }
}

export type RenderPartKind = 'input' | 'output';

/** Refuse early when the byte store cannot hold the queue's namespaces. */
export async function assertRenderQueueStorage(
  queryable: Parameters<typeof resolveConfiguredAssetByteStore>[0],
): Promise<void> {
  const base = await resolveConfiguredAssetByteStore(queryable);
  if (typeof base.withPrefix !== 'function') throw new RenderQueueStorageUnavailableError();
}

/**
 * The namespace of one kind of a job's parts.
 *
 * Parts are deleted only from the PostgreSQL byte layer, where every export
 * would otherwise grow the database. An object store (`writesOutsideRegistryDatabase`)
 * keeps them: its `delete` here does nothing, and the bucket's own lifecycle
 * decides. Pass a transaction as `queryable` to delete PostgreSQL parts in it.
 */
export async function renderJobBytes(
  queryable: Parameters<typeof resolveConfiguredAssetByteStore>[0],
  jobId: string,
  kind: RenderPartKind,
): Promise<AssetByteStore> {
  const base = await resolveConfiguredAssetByteStore(queryable);
  if (typeof base.withPrefix !== 'function') throw new RenderQueueStorageUnavailableError();
  const store = base.withPrefix(`render-jobs/${jobId}/${kind}/`);
  if (base.writesOutsideRegistryDatabase !== true) return store;
  return {
    write: (hash, bytes, options) => store.write(hash, bytes, options),
    read: (hash) => store.read(hash),
    delete: async () => undefined,
  };
}

function hashOf(bytes: Uint8Array): Hash {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}` as Hash;
}

/** Cut a stream into parts of {@link RENDER_PART_BYTES}, the last one shorter. */
async function* parts(source: AsyncIterable<Uint8Array>, maximum: number) {
  let pending = Buffer.alloc(RENDER_PART_BYTES);
  let used = 0;
  let total = 0;
  for await (const bytes of source) {
    total += bytes.byteLength;
    if (total > maximum) throw new RenderPartsTooLargeError();
    let offset = 0;
    while (offset < bytes.byteLength) {
      const n = Math.min(RENDER_PART_BYTES - used, bytes.byteLength - offset);
      pending.set(bytes.subarray(offset, offset + n), used);
      used += n;
      offset += n;
      if (used === RENDER_PART_BYTES) {
        yield pending;
        pending = Buffer.alloc(RENDER_PART_BYTES);
        used = 0;
      }
    }
  }
  if (used) yield pending.subarray(0, used);
}

/** The app's own byte store or database failed while storing a part. */
export class RenderPartStoreError extends Error {
  constructor(cause: unknown) {
    super('Storing a render part failed', { cause });
    this.name = 'RenderPartStoreError';
  }
}

/**
 * Store `source` as parts of the job's `kind` namespace. Each part is recorded
 * on the row (`record`, which answers false once the job may no longer take
 * parts) with its bytes:
 *
 * - in PostgreSQL, in one transaction, so a part is listed exactly when its
 *   bytes are stored and the sweep, which takes parts under the row lock,
 *   can never miss one;
 * - in an object store, recorded first and then written: a write that fails
 *   still leaves a listed part, and object-store parts are never deleted here.
 *
 * Failures of the app's own storage are thrown as {@link RenderPartStoreError};
 * a failure reading `source` is thrown as it is. Answers the total size, or
 * null when the job stopped taking parts.
 */
export async function writeRenderParts(
  jobId: string,
  kind: RenderPartKind,
  source: AsyncIterable<Uint8Array>,
  maximum: number,
  record: (part: RenderJobPart, totalBytes: number, queryable: Queryable) => Promise<boolean>,
): Promise<number | null> {
  let persistence: Awaited<ReturnType<typeof renderQueuePersistence>>;
  let external: AssetByteStore | null;
  try {
    persistence = await renderQueuePersistence();
    const base = await resolveConfiguredAssetByteStore(persistence.pool);
    external =
      base.writesOutsideRegistryDatabase === true
        ? await renderJobBytes(persistence.pool, jobId, kind)
        : null;
  } catch (error) {
    throw new RenderPartStoreError(error);
  }
  const { pool, withTransaction } = persistence;
  let total = 0;
  for await (const chunk of parts(source, maximum)) {
    total += chunk.byteLength;
    const part = { hash: hashOf(chunk), bytes: chunk.byteLength };
    let kept: boolean;
    try {
      if (external) {
        kept = await record(part, total, pool);
        if (kept) await external.write(part.hash as Hash, chunk);
      } else {
        kept = await withTransaction(async (tx) => {
          if (!(await record(part, total, tx))) return false;
          await (await renderJobBytes(tx, jobId, kind)).write(part.hash as Hash, chunk);
          return true;
        });
      }
    } catch (error) {
      throw new RenderPartStoreError(error);
    }
    if (!kept) return null;
  }
  return total;
}

/** Read the parts back in order, checking each against its recorded hash and size. */
export async function* readRenderParts(
  store: AssetByteStore,
  recorded: readonly RenderJobPart[],
): AsyncGenerator<Uint8Array> {
  for (const part of recorded) {
    if (!/^sha256-[a-f0-9]{64}$/.test(part.hash)) throw new RenderPartCorruptError();
    const data = await store.read(part.hash as Hash);
    if (!data || data.byteLength !== part.bytes || hashOf(data) !== part.hash) {
      throw new RenderPartCorruptError();
    }
    yield data;
  }
}

/** Delete the parts (idempotent: a part already gone is fine). */
export async function deleteRenderParts(
  store: AssetByteStore,
  recorded: readonly RenderJobPart[],
): Promise<void> {
  for (const hash of new Set(recorded.map((part) => part.hash))) {
    if (!/^sha256-[a-f0-9]{64}$/.test(hash)) continue;
    await store.delete(hash as Hash);
  }
}

/**
 * A request or response body over the parts, read one part at a time.
 * `onError` sees why the stream failed (a fetch consuming it reports only
 * that its body broke); `onEnd` runs once the reader took the last part.
 */
export function renderPartsBody(
  store: AssetByteStore,
  recorded: readonly RenderJobPart[],
  onError?: (error: unknown) => void,
  onEnd?: () => void,
): ReadableStream<Uint8Array> {
  const iterator = readRenderParts(store, recorded);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          onEnd?.();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        onError?.(error);
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
