import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import {
  getReadyOwnerMaterial,
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

export function isOwnerMaterialId(value: string): boolean {
  return OWNER_MATERIAL_ID.test(value);
}

async function ownerMaterialQueryable(override?: Queryable): Promise<Queryable> {
  if (override) return override;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Agent runtime requires DATABASE_URL');
  return (await getServerPersistenceProvider(connectionString)).pool;
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
