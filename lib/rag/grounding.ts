import type { GroundingContextRef } from './types';

export function createGroundingContextRef(snapshotId?: string): GroundingContextRef | undefined {
  const normalizedSnapshotId = snapshotId?.trim();
  return normalizedSnapshotId ? { snapshotId: normalizedSnapshotId } : undefined;
}
