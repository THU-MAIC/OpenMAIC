import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { AssetByteStore } from '@openmaic/storage/asset/pg';
import type { ServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  resolveConfiguredAssetByteStore,
  createAssetByteStore,
  configuredS3Bucket,
} from '@/lib/persistence/asset-byte-store';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import { SandboxError, sandboxConflict } from '@/lib/sandbox/errors';
import type { SandboxRow } from './store';
import { checkpointIO } from './checkpoint-errors';
import {
  CHECKPOINT_TIMEOUT_MS,
  checkpointPolicy,
  checkpointArchiveLimit,
  checkpointOwnerQuota,
  checkpointPrefix,
  type CheckpointPolicy,
} from './checkpoint-policy';

const CHUNK_BYTES = 8 * 1024 ** 2;
type Hash = Parameters<AssetByteStore['write']>[0];
interface Part {
  hash: Hash;
  bytes: number;
}
interface StoredObject {
  id: string;
  source_environment_id: string;
  object_prefix: string;
  parts_json: Part[];
  policy_json: CheckpointPolicy;
  archive_size: string;
  state: 'pending' | 'committed' | 'retired';
}
export interface SavedCheckpoint {
  revision: number;
  archive_hash: string;
  object_id: string;
  archive_size: string;
  created_at: Date;
}
function hash(bytes: Uint8Array): Hash {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}` as Hash;
}
/** Fixed-size objects let existing byte backends handle large archives without a whole-archive buffer. */
export async function* checkpointChunks(
  source: AsyncIterable<Uint8Array>,
  maximum: number,
  signal?: AbortSignal,
) {
  let pending = Buffer.alloc(CHUNK_BYTES),
    used = 0,
    total = 0;
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = signal
        ? await checkpointIO(() => iterator.next(), signal)
        : await iterator.next();
      if (next.done) break;
      const bytes = next.value;
      total += bytes.byteLength;
      if (total > maximum)
        throw new SandboxError(
          'CHECKPOINT_ARCHIVE_LIMIT',
          409,
          'Checkpoint exceeds the configured archive limit.',
        );
      let offset = 0;
      while (offset < bytes.byteLength) {
        const n = Math.min(CHUNK_BYTES - used, bytes.byteLength - offset);
        pending.set(bytes.subarray(offset, offset + n), used);
        used += n;
        offset += n;
        if (used === CHUNK_BYTES) {
          yield pending;
          pending = Buffer.alloc(CHUNK_BYTES);
          used = 0;
        }
      }
    }
    if (used) yield pending.subarray(0, used);
    if (!total) throw sandboxConflict('Empty checkpoint archive.');
  } finally {
    const closing = iterator.return?.();
    if (closing) {
      if (signal?.aborted) void closing.catch(() => {});
      else if (signal) await checkpointIO(() => closing, signal);
      else await closing;
    }
  }
}

export class CheckpointStorage {
  constructor(
    private readonly persistence: ServerPersistenceProvider,
    private readonly exclusive: <T>(key: string, action: () => Promise<T>) => Promise<T>,
    private readonly resolveBytes = () => {
      const bucket = configuredS3Bucket(process.env.OPENMAIC_SANDBOX_CHECKPOINT_S3_BUCKET);
      return bucket
        ? createAssetByteStore(bucket, persistence.pool)
        : resolveConfiguredAssetByteStore(persistence.pool);
    },
  ) {}

  private async bytes(prefix: string): Promise<AssetByteStore> {
    const base = await this.resolveBytes();
    if (base.writesOutsideRegistryDatabase !== true || !base.withPrefix)
      throw new SandboxError(
        'SANDBOX_CHECKPOINT_STORAGE_UNAVAILABLE',
        503,
        'Checkpoints require an external byte store with isolated-prefix support. Configure S3 or a compatible host storage adapter.',
      );
    return base.withPrefix(prefix);
  }
  async available(): Promise<boolean> {
    try {
      await this.bytes(checkpointPrefix());
      return true;
    } catch {
      return false;
    }
  }
  async get(owner: string, workspace: string): Promise<SavedCheckpoint | null> {
    return (
      (
        await this.persistence.pool.query<SavedCheckpoint>(
          `SELECT revision,archive_hash,object_id,archive_size,created_at
       FROM sandbox_workspace_checkpoints WHERE owner_id=$1 AND workspace_id=$2`,
          [owner, workspace],
        )
      ).rows[0] ?? null
    );
  }

  /** Caller holds the source environment lock throughout export, upload and commit. */
  async saveLocked(
    row: SandboxRow,
    revision: number,
    source: AsyncIterable<Uint8Array>,
    signal = AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS),
  ) {
    const policy = checkpointPolicy(),
      id = randomUUID();
    const prefix = checkpointPrefix() + id + '/';
    // Fail before consuming/exporting the workspace when external storage is unavailable.
    const bytes = await checkpointIO(() => this.bytes(prefix), signal);
    {
      await this.persistence.withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, row.owner_id);
        const current = await tx.query<{ revision: number }>(
          'SELECT revision FROM sandbox_workspace_checkpoints WHERE owner_id=$1 AND workspace_id=$2',
          [row.owner_id, row.workspace_id],
        );
        if ((current.rows[0]?.revision ?? 0) !== revision)
          throw sandboxConflict('A newer checkpoint exists. Refresh before saving.');
        await tx.query(
          `INSERT INTO sandbox_checkpoint_objects(id,owner_id,workspace_id,object_prefix,policy_json,state,source_environment_id)
          VALUES($1,$2,$3,$4,$5::jsonb,'pending',$6)`,
          [id, row.owner_id, row.workspace_id, prefix, JSON.stringify(policy), row.id],
        );
      });
      const parts: Part[] = [];
      const digest = createHash('sha256');
      let size = 0;
      for await (const chunk of checkpointChunks(source, checkpointArchiveLimit(policy), signal)) {
        digest.update(chunk);
        size += chunk.byteLength;
        parts.push({ hash: hash(chunk), bytes: chunk.byteLength });
        // Record the exact key BEFORE PUT. An uncertain/failed PUT remains reclaimable.
        await this.persistence.withTransaction(async (tx) => {
          await fenceOwnerWrite(tx, row.owner_id);
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `sandbox.checkpoint:${row.owner_id}`,
          ]);
          const usage = await tx.query<{ bytes: string }>(
            `SELECT COALESCE(sum(archive_size),0)::text AS bytes FROM sandbox_checkpoint_objects WHERE owner_id=$1 AND id<>$2`,
            [row.owner_id, id],
          );
          if (Number(usage.rows[0].bytes) + size > checkpointOwnerQuota())
            throw new SandboxError(
              'SANDBOX_STORAGE_LIMIT',
              429,
              'Checkpoint storage quota reached. Reclaim retired checkpoints before retrying.',
            );
          await tx.query(
            `UPDATE sandbox_checkpoint_objects SET parts_json=$2::jsonb,archive_size=$3,updated_at=now() WHERE id=$1 AND state='pending'`,
            [id, JSON.stringify(parts), size],
          );
        });
        await checkpointIO(() => bytes.write(parts.at(-1)!.hash, chunk, { signal }), signal);
      }
      signal.throwIfAborted();
      const archiveHash = digest.digest('hex');
      await this.persistence.withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, row.owner_id);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `sandbox.checkpoint:${row.owner_id}`,
        ]);
        const current = (
          await tx.query<{ revision: number; object_id: string | null }>(
            'SELECT revision,object_id FROM sandbox_workspace_checkpoints WHERE owner_id=$1 AND workspace_id=$2',
            [row.owner_id, row.workspace_id],
          )
        ).rows[0];
        if ((current?.revision ?? 0) !== revision)
          throw sandboxConflict('A newer checkpoint exists. Refresh before saving.');
        signal.throwIfAborted();
        if (current?.object_id)
          await tx.query(
            "UPDATE sandbox_checkpoint_objects SET state='retired',updated_at=now() WHERE id=$1",
            [current.object_id],
          );
        await tx.query(
          `INSERT INTO sandbox_workspace_checkpoints(owner_id,workspace_id,revision,source_environment_id,archive_hash,object_id,archive_size)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(owner_id,workspace_id) DO UPDATE SET
          revision=EXCLUDED.revision,source_environment_id=EXCLUDED.source_environment_id,archive_hash=EXCLUDED.archive_hash,
          object_id=EXCLUDED.object_id,archive_size=EXCLUDED.archive_size,created_at=now()`,
          [row.owner_id, row.workspace_id, revision + 1, row.id, archiveHash, id, size],
        );
        await tx.query(
          "UPDATE sandbox_checkpoint_objects SET state='committed',updated_at=now() WHERE id=$1",
          [id],
        );
      });
      return { revision: revision + 1, hash: archiveHash, bytes: size };
    }
  }

  async *read(owner: string, saved: SavedCheckpoint): AsyncIterable<Uint8Array> {
    const object = (
      await this.persistence.pool.query<StoredObject>(
        `SELECT * FROM sandbox_checkpoint_objects WHERE id=$1 AND owner_id=$2 AND state='committed'`,
        [saved.object_id, owner],
      )
    ).rows[0];
    if (!object) throw sandboxConflict('Checkpoint storage metadata is unavailable.');
    const rootsKey = (p: CheckpointPolicy) =>
      JSON.stringify(p.roots.map((r) => [r.name, r.path, r.excludes]));
    if (rootsKey(object.policy_json) !== rootsKey(checkpointPolicy()))
      throw sandboxConflict(
        'Checkpoint paths changed. Restore the deployment path configuration before opening this project.',
      );
    const bytes = await this.bytes(object.object_prefix),
      digest = createHash('sha256');
    let size = 0;
    for (const part of object.parts_json) {
      if (!/^sha256-[a-f0-9]{64}$/.test(part.hash) || part.bytes < 1 || part.bytes > CHUNK_BYTES)
        throw sandboxConflict('Checkpoint metadata is invalid.');
      const data = await bytes.read(part.hash);
      if (!data || data.byteLength !== part.bytes || hash(data) !== part.hash)
        throw sandboxConflict('Checkpoint chunk checksum does not match.');
      digest.update(data);
      size += data.byteLength;
      yield data;
    }
    if (size !== Number(saved.archive_size) || digest.digest('hex') !== saved.archive_hash)
      throw sandboxConflict('Checkpoint checksum does not match.');
  }

  /** Separate collector: never enumerates course assets or calls their collector. */
  async collect(limit = 100) {
    const candidates = (
      await this.persistence.pool.query<{ id: string; source_environment_id: string }>(
        `SELECT id,source_environment_id FROM sandbox_checkpoint_objects WHERE
       (state='retired' AND updated_at<now()-interval '1 hour') OR
       (state='pending' AND updated_at<now()-interval '24 hours') ORDER BY updated_at LIMIT $1`,
        [limit],
      )
    ).rows;
    const result = { collected: 0, deferred: 0 };
    for (const { id, source_environment_id } of candidates) {
      try {
        await this.exclusive(source_environment_id, async () => {
          const object = (
            await this.persistence.pool.query<StoredObject>(
              `SELECT * FROM sandbox_checkpoint_objects o WHERE id=$1 AND
          ((state='retired' AND updated_at<now()-interval '1 hour') OR (state='pending' AND updated_at<now()-interval '24 hours'))
          AND NOT EXISTS(SELECT 1 FROM sandbox_workspace_checkpoints c WHERE c.object_id=o.id)`,
              [id],
            )
          ).rows[0];
          if (!object) return;
          const bytes = await this.bytes(object.object_prefix);
          for (const part of object.parts_json) {
            if (!/^sha256-[a-f0-9]{64}$/.test(part.hash)) throw new Error('Invalid checkpoint key');
            await bytes.delete(part.hash);
          }
          await this.persistence.pool.query(
            "DELETE FROM sandbox_checkpoint_objects WHERE id=$1 AND state<>'committed'",
            [id],
          );
          result.collected++;
        });
      } catch {
        result.deferred++;
      }
    }
    return result;
  }
}
