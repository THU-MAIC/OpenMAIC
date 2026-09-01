import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';
import type { WithTransaction } from '@openmaic/storage/runtime/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import {
  getReadyOwnerMaterial,
  getReadyOwnerMaterialsForSnapshot,
  purgeDeletedOwnerMaterial,
  tombstoneOwnerMaterial,
  type OwnerMaterialRecord,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import { getMaterialByteStore, type MaterialByteStore } from './bytes';

const OWNER_MATERIAL_ID = /^mat_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;

export interface VerifiedOwnerMaterialAsset {
  record: OwnerMaterialRecord;
  bytes: Buffer;
  ownerMaterialId: string;
  sha256: string;
  mimeType: string;
  byteLength: number;
}

interface OwnerMaterialAssetDependencies {
  queryable?: Queryable;
  byteStore?: MaterialByteStore;
}

export interface OwnerMaterialSnapshotSourceDependencies {
  withTransaction?: WithTransaction;
  byteStore?: MaterialByteStore;
}

export interface OwnerMaterialSnapshotSourceRequirements {
  allowedMimeTypes: ReadonlySet<string>;
}

export type OwnerMaterialSnapshotSourceResult =
  | { ok: true; assets: VerifiedOwnerMaterialAsset[] }
  | {
      ok: false;
      reason: 'unavailable' | 'unsupported_mime' | 'integrity_failed';
    };

export function isOwnerMaterialId(value: string): boolean {
  return OWNER_MATERIAL_ID.test(value);
}

async function ownerMaterialQueryable(override?: Queryable): Promise<Queryable> {
  if (override) return override;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  return (await getServerPersistenceProvider(connectionString)).pool;
}

async function ownerMaterialSnapshotTransaction(
  override?: WithTransaction,
): Promise<WithTransaction> {
  if (override) return override;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  const provider = await getServerPersistenceProvider(connectionString);
  return nodePostgresTransaction(provider.pool as unknown as ConnectableQueryable);
}

export async function verifyOwnerMaterialBytes(
  record: OwnerMaterialRecord,
  byteStore: MaterialByteStore = getMaterialByteStore(),
): Promise<VerifiedOwnerMaterialAsset | null> {
  if (record.status !== 'ready' || record.deletedAt !== null || !record.sha256) return null;
  let bytes: Buffer;
  try {
    bytes = await byteStore.get(record.ossKey);
  } catch {
    return null;
  }
  if (bytes.byteLength !== record.bytes) return null;
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== record.sha256) return null;
  return {
    record,
    bytes,
    ownerMaterialId: record.id,
    sha256: record.sha256,
    mimeType: record.mime ?? 'application/octet-stream',
    byteLength: record.bytes,
  };
}

/** Owner-bound raw resolver used by binding and future Exam intake. */
export async function resolveOwnedReadyMaterialAsset(
  ownerId: string,
  materialId: string,
  dependencies: OwnerMaterialAssetDependencies = {},
): Promise<VerifiedOwnerMaterialAsset | null> {
  if (!isOwnerMaterialId(materialId)) return null;
  const queryable = await ownerMaterialQueryable(dependencies.queryable);
  const record = await getReadyOwnerMaterial(queryable, ownerId, materialId);
  if (!record) return null;
  return verifyOwnerMaterialBytes(record, dependencies.byteStore ?? getMaterialByteStore());
}

/**
 * Capture owner-library source bytes for an immutable Exam snapshot.
 *
 * Unlike the ordinary resolver, this operation locks every selected metadata
 * row in one transaction and keeps those locks through byte read + integrity
 * verification. Owner deletion tombstones the same rows, so exactly one side
 * wins: a prior tombstone is unavailable, while a prior snapshot read returns
 * an authoritative in-memory copy that remains usable after the source is
 * deleted. No storage error or object locator crosses this boundary.
 */
export async function resolveOwnedReadyMaterialAssetsForSnapshot(
  ownerId: string,
  materialIds: readonly string[],
  requirements: OwnerMaterialSnapshotSourceRequirements,
  dependencies: OwnerMaterialSnapshotSourceDependencies = {},
): Promise<OwnerMaterialSnapshotSourceResult> {
  const orderedIds = [...new Set(materialIds)].sort();
  if (orderedIds.some((materialId) => !isOwnerMaterialId(materialId))) {
    return { ok: false, reason: 'unavailable' };
  }
  if (orderedIds.length === 0) return { ok: true, assets: [] };

  const withTransaction = await ownerMaterialSnapshotTransaction(dependencies.withTransaction);
  const byteStore = dependencies.byteStore ?? getMaterialByteStore();
  return withTransaction(async (transaction) => {
    const records = await getReadyOwnerMaterialsForSnapshot(transaction, ownerId, orderedIds);
    if (records.length !== orderedIds.length) return { ok: false, reason: 'unavailable' };

    const assets: VerifiedOwnerMaterialAsset[] = [];
    for (let index = 0; index < orderedIds.length; index += 1) {
      const record = records[index];
      if (!record || record.id !== orderedIds[index]) {
        return { ok: false, reason: 'unavailable' };
      }
      if (!record.mime || !requirements.allowedMimeTypes.has(record.mime)) {
        return { ok: false, reason: 'unsupported_mime' };
      }

      let bytes: Buffer;
      try {
        bytes = await byteStore.get(record.ossKey);
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (bytes.byteLength !== record.bytes || digest !== record.sha256) {
        return { ok: false, reason: 'integrity_failed' };
      }
      assets.push({
        record,
        bytes,
        ownerMaterialId: record.id,
        sha256: digest,
        mimeType: record.mime,
        byteLength: bytes.byteLength,
      });
    }
    return { ok: true, assets };
  });
}

/**
 * Hide an owned material, remove its independent owner bytes, then purge the tombstone.
 * Byte or purge failure leaves a non-visible row with its pointer so the call can retry.
 */
export async function deleteOwnedMaterial(
  ownerId: string,
  materialId: string,
  dependencies: OwnerMaterialAssetDependencies = {},
): Promise<'deleted' | 'absent'> {
  if (!isOwnerMaterialId(materialId)) return 'absent';
  const queryable = await ownerMaterialQueryable(dependencies.queryable);
  const tombstone = await tombstoneOwnerMaterial(queryable, ownerId, materialId);
  if (!tombstone) return 'absent';
  if (tombstone.ossKey !== '') {
    const byteStore = dependencies.byteStore ?? getMaterialByteStore();
    await byteStore.delete(tombstone.ossKey);
  }
  await purgeDeletedOwnerMaterial(queryable, ownerId, materialId);
  return 'deleted';
}
