/**
 * Read an owner material's original bytes, pool first.
 *
 * A material in the asset pool (`asset_id`) is read from its entry, under the
 * owner's own partition; a material from before the pool is read from the
 * material byte store by its object key (`oss_key`), and only when the object
 * matches the digest recorded at upload. Both binding a material to a
 * conversation and owner-level extraction read through here.
 *
 * ## One re-read, under the owner's fence
 *
 * The caller's record can be older than the row, and the first read can fail
 * for reasons the row now explains. After a failed first read -- nothing found,
 * or a pool read that threw -- the row is re-read and its pool entry read in
 * one transaction that first takes the record owner's write fence
 * (`forwardOwnerWrite`, the shared identity lock): a claim of that owner takes
 * the lock exclusively, so the row's owner cannot change between the re-read
 * and the read of the entry. The lock is held through the whole pool read,
 * byte-store I/O included, so a claim of that owner waits for it; only the
 * wait to take the fence is bounded (`OWNER_WRITE_LOCK_WAIT_MS`). When that
 * pool read also fails, the old object the re-read names is tried last, after
 * the transaction, with the digest the same re-read returned.
 *
 * - **The backfill moved it.** The backfill deletes an old object only after
 *   the row's pool pointer has committed (`./migrate-to-pool.ts`), and nothing
 *   else deletes the object of a ready row. So when the object is gone, the
 *   re-read finds the pointer.
 * - **A claim moved it.** A claim moves the row and re-keys its pool entry to
 *   the account in one transaction, so an owner read before the claim names a
 *   partition the entry is no longer in. The re-read finds the row's owner now,
 *   and the entry under it, and the fence keeps a claim from moving both again
 *   before the read. (Owner extraction keeps working for the account after a
 *   claim, as the rest of its writes do. Claims never chain: the account a
 *   claim moves into is never itself claimed.)
 * - **The backfill kept the old object.** When the backfill's delete of an old
 *   object fails, the row keeps both its pointer and its `oss_key` until a
 *   later pass. If the pool cannot be read, that object is still the original.
 *
 * A row the backfill moves between the re-read and the old-object read (no
 * pointer yet at the re-read, the object deleted just after) answers
 * unavailable for that read, never with other bytes. An old object that does
 * not match its recorded digest, or a row with no digest, is never returned.
 */
import { createHash } from 'node:crypto';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { forwardOwnerWrite } from '@/lib/persistence/owner-merges';
import type { OwnerMaterialRecord } from '@/lib/persistence/owner-materials';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';

/** No stored bytes could be read for the material. */
export class OwnerMaterialBytesUnavailableError extends Error {
  constructor(readonly materialId: string) {
    super(`material ${materialId} bytes are unavailable`);
    this.name = 'OwnerMaterialBytesUnavailableError';
  }
}

type OwnerMaterialLocation = Pick<
  OwnerMaterialRecord,
  'id' | 'ownerId' | 'assetId' | 'ossKey' | 'sha256'
>;

/** Where the re-read found the row's old object, if it has one. */
interface OldObject {
  ossKey: string;
  sha256: string | null;
}

/** A pool read inside the fenced re-read threw; carries what the re-read found. */
class FencedPoolReadFailed extends Error {
  constructor(
    readonly oldObject: OldObject,
    options: { cause: unknown },
  ) {
    super('pool read failed', options);
  }
}

/** The old object's bytes, only when they match the recorded digest. */
async function readOldObject({ ossKey, sha256 }: OldObject): Promise<Buffer | null> {
  if (!ossKey || !sha256) return null;
  let bytes: Buffer;
  try {
    bytes = await getMaterialByteStore().get(ossKey);
  } catch {
    return null;
  }
  return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null;
}

async function readOnce(location: OwnerMaterialLocation): Promise<Buffer | null> {
  if (location.assetId) {
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    try {
      const read = await provider.assetStore.resolve(
        assetPrincipalForOwner(location.ownerId),
        location.assetId,
      );
      return read ? Buffer.from(read.bytes) : null;
    } catch {
      // Retried under the fence, then the old object.
      return null;
    }
  }
  return readOldObject(location);
}

/**
 * Re-read the row and read its pool entry, both under the fence of the
 * record's owner: the row's owner cannot change between the two reads.
 * `bytes` is null when the row has no pool pointer or its entry could not be
 * read; `oldObject` is what the re-read found (null when the row is gone).
 * A failure to take the fence or to re-read the row is thrown.
 */
async function rereadAndReadPool(
  record: OwnerMaterialLocation,
): Promise<{ bytes: Buffer | null; oldObject: OldObject | null }> {
  const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  try {
    return await provider.withTransaction(async (tx) => {
      await forwardOwnerWrite(tx, record.ownerId);
      const found = await tx.query<{
        owner_id: string;
        asset_id: string | null;
        oss_key: string;
        sha256: string | null;
      }>('SELECT owner_id, asset_id, oss_key, sha256 FROM owner_material WHERE id = $1', [
        record.id,
      ]);
      const row = found.rows[0];
      if (!row) return { bytes: null, oldObject: null };
      const oldObject = { ossKey: row.oss_key, sha256: row.sha256 };
      if (!row.asset_id) return { bytes: null, oldObject };
      try {
        const read = await provider
          .assetStoreIn(tx)
          .resolve(assetPrincipalForOwner(row.owner_id), row.asset_id);
        return { bytes: read ? Buffer.from(read.bytes) : null, oldObject };
      } catch (error) {
        // Out of the transaction, so it rolls back: a failed statement leaves
        // it aborted, and only a rollback ends that.
        throw new FencedPoolReadFailed(oldObject, { cause: error });
      }
    });
  } catch (error) {
    if (error instanceof FencedPoolReadFailed) return { bytes: null, oldObject: error.oldObject };
    throw error;
  }
}

/**
 * The material's original bytes.
 *
 * @throws OwnerMaterialBytesUnavailableError when neither the record nor the
 *   row as it is now leads to stored bytes that can be trusted.
 */
export async function readOwnerMaterialBytes(record: OwnerMaterialLocation): Promise<Buffer> {
  const first = await readOnce(record);
  if (first) return first;
  const { bytes, oldObject } = await rereadAndReadPool(record);
  if (bytes) return bytes;
  const old = oldObject ? await readOldObject(oldObject) : null;
  if (old) return old;
  throw new OwnerMaterialBytesUnavailableError(record.id);
}
