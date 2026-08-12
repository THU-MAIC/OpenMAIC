/**
 * PostgreSQL byte storage for the server asset registry.
 *
 * Asset bytes stored here flow through PostgreSQL's write-ahead log, replicas,
 * and backups. Deployments should size their asset limit with that replication
 * and backup volume in mind.
 */
import type { ContentHash } from './blob.js';
import type { AssetByteStore } from './byte-store.js';
import type { Queryable } from '../runtime/pg.js';

function byteStoreFailure(operation: string): Error {
  return new Error(`@openmaic/storage: PostgreSQL asset byte ${operation} failed`);
}

interface ByteRow extends Record<string, unknown> {
  bytes: Uint8Array | ArrayBuffer | null;
}

function asUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  return new Uint8Array(value.slice(0));
}

export class PgAssetByteStore implements AssetByteStore {
  constructor(private readonly queryable: Queryable) {}

  async write(hash: ContentHash, bytes: Uint8Array): Promise<void> {
    try {
      await this.queryable.query(
        `INSERT INTO asset_blobs (content_hash, byte_size, bytes, unreferenced_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (content_hash) DO UPDATE
           SET byte_size = EXCLUDED.byte_size,
               bytes = EXCLUDED.bytes,
               unreferenced_at = now()`,
        [hash, bytes.byteLength, bytes],
      );
    } catch {
      throw byteStoreFailure('write');
    }
  }

  /**
   * Use a transaction-pinned queryable for the registry's coordinated rewrite.
   * This is an implementation hook, not an additional byte-store capability.
   */
  async writeWith(queryable: Queryable, hash: ContentHash, bytes: Uint8Array): Promise<void> {
    await queryable.query(
      `UPDATE asset_blobs
          SET byte_size = $2,
              bytes = $3
        WHERE content_hash = $1`,
      [hash, bytes.byteLength, bytes],
    );
  }

  async read(hash: ContentHash): Promise<Uint8Array | null> {
    try {
      return await this.readWith(this.queryable, hash);
    } catch {
      throw byteStoreFailure('read');
    }
  }

  /** Use a transaction-pinned queryable when the registry resolves an entry. */
  async readWith(queryable: Queryable, hash: ContentHash): Promise<Uint8Array | null> {
    const result = await queryable.query<ByteRow>(
      'SELECT bytes FROM asset_blobs WHERE content_hash = $1',
      [hash],
    );
    const bytes = result.rows[0]?.bytes;
    return bytes === undefined || bytes === null ? null : asUint8Array(bytes);
  }

  async delete(hash: ContentHash): Promise<void> {
    try {
      await this.deleteWith(this.queryable, hash);
    } catch {
      throw byteStoreFailure('delete');
    }
  }

  /** Use the collector's transaction-pinned queryable for byte clearing. */
  async deleteWith(queryable: Queryable, hash: ContentHash): Promise<void> {
    await queryable.query('UPDATE asset_blobs SET bytes = NULL WHERE content_hash = $1', [hash]);
  }
}

export type { AssetByteStore } from './byte-store.js';
export type { Queryable } from '../runtime/pg.js';
