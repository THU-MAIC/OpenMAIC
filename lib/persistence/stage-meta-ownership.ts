import type { DocumentOwnershipRelation } from '@openmaic/storage/document/pg';

/**
 * `stage_meta` as the storage package's document ownership relation: the one
 * place a course's owner is recorded. The owner-bound document store scopes
 * listings, writes and folder membership through it, and the asset
 * collector's backfill reads each course's owner from it. Ownership rows are
 * claimed by this application (with the host create hooks), never by the
 * package.
 */
export const STAGE_META_OWNERSHIP: DocumentOwnershipRelation = {
  table: 'stage_meta',
  stageIdColumn: 'stage_id',
  ownerIdColumn: 'owner_id',
  tombstoneColumn: 'deleted_at',
};
