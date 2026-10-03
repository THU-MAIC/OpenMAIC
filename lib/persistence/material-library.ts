/**
 * Organizing the material library: folders, moving and renaming (RFC #1716
 * §5). These are the shared operations: the library page's HTTP routes and
 * the agent's tools are thin adapters that resolve the owner and call them.
 *
 * ## Fences
 *
 * Every write takes the owner's write fence first. Which one follows the
 * caller, not the operation: a request (`'request'`, `fenceOwnerWrite`)
 * refuses a retired owner; an agent run (`'background'`,
 * `forwardOwnerWrite`) follows a claim to the account, as the run's other
 * writes do. Rows are then checked against the owner the fence returned.
 *
 * ## Folders
 *
 * Flat, owner-scoped, Unfiled is `folder_id IS NULL`. Names follow course
 * folders: the display-width rule of `lib/utils/folder-name-validation.ts`,
 * unique per owner by their lower-cased form, at most
 * `FOLDER_COUNT_LIMIT` per owner. Creating a name the owner already has
 * returns that folder (`created: false`).
 *
 * ## Moving a source moves its derivatives
 *
 * Derivatives are filed with their source and are never moved on their own.
 * A move locks the sources (one ascending statement), then updates the
 * sources and every row derived from them. A publication inserts a source's
 * derivatives only while it holds that source's lock, so once the move holds
 * it, the set of derivatives is complete and stays so until the move commits:
 * none can be published into the old folder behind it.
 *
 * ## Deleting a folder
 *
 * Only an empty folder is deleted; one that still holds a live material is
 * refused. A move into the folder locks it `FOR KEY SHARE` first and a
 * deletion `FOR UPDATE`, so whichever comes second sees what the first did:
 * no material is filed in a folder that is gone, and no folder is deleted
 * with a material in it. A deleted material (a tombstone) no longer counts;
 * its filing is cleared so the folder's foreign key lets the row go.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';

import {
  FOLDER_COUNT_LIMIT,
  validateFolderName,
  type FolderNameValidationError,
} from '@/lib/utils/folder-name-validation';

import { fenceOwnerWrite, forwardOwnerWrite } from './owner-merges';

export type LibraryFence = 'request' | 'background';

export interface MaterialFolder {
  id: string;
  name: string;
  /** Live sources filed in it (derivatives follow their source). */
  materialCount: number;
  createdAt: number;
  updatedAt: number;
}

/** The longest display name a material may have, in characters. */
export const MATERIAL_NAME_MAX_LENGTH = 255;

/** At most this many materials in one move. */
export const MAX_MOVE_MATERIALS = 100;

async function fence(tx: Queryable, ownerId: string, kind: LibraryFence): Promise<string> {
  if (kind === 'request') {
    await fenceOwnerWrite(tx, ownerId);
    return ownerId;
  }
  return forwardOwnerWrite(tx, ownerId);
}

function normalizedFolderName(name: string): string {
  return name.toLocaleLowerCase('en-US');
}

/** Lock key that serializes one owner's folder creations (the count limit). */
function folderCreationLockKey(ownerId: string): string {
  return `material-folders:${ownerId}:create`;
}

interface FolderRow extends Record<string, unknown> {
  id: string;
  name: string;
  material_count?: number | string;
  created_at: number | string;
  updated_at: number | string;
}

function folderOf(row: FolderRow): MaterialFolder {
  return {
    id: row.id,
    name: row.name,
    materialCount: Number(row.material_count ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

/** `%`, `_` and `\` taken literally in a LIKE pattern. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The owner's folders by name, each with how many live sources it holds. */
export async function listMaterialFolders(
  queryable: Queryable,
  ownerId: string,
  options: { query?: string } = {},
): Promise<MaterialFolder[]> {
  const params: unknown[] = [ownerId];
  let filter = '';
  if (options.query) {
    params.push(`%${likeLiteral(options.query)}%`);
    filter = `AND folder.name ILIKE $2 ESCAPE '\\'`;
  }
  const result = await queryable.query<FolderRow>(
    `SELECT folder.id, folder.name, folder.created_at, folder.updated_at,
            (SELECT COUNT(*) FROM owner_material AS material
              WHERE material.owner_id = folder.owner_id AND material.folder_id = folder.id
                AND material.derived_from IS NULL AND material.deleted_at IS NULL
                AND material.status = 'ready')::text AS material_count
       FROM material_folders AS folder
      WHERE folder.owner_id = $1 ${filter}
      ORDER BY folder.normalized_name, folder.id`,
    params,
  );
  return result.rows.map(folderOf);
}

export type FolderNameRefusal = { status: 'invalid_name'; reason: FolderNameValidationError };

export type CreateMaterialFolderOutcome =
  | { status: 'ok'; folder: MaterialFolder; created: boolean }
  | FolderNameRefusal
  | { status: 'limit'; limit: number };

/**
 * Create a folder, or return the owner's folder of the same name
 * (`created: false`). One creation per owner at a time, so the count limit
 * holds under concurrent calls.
 */
export async function createMaterialFolder(
  persistence: { withTransaction: WithTransaction },
  input: { ownerId: string; name: string; fence: LibraryFence },
  now: number = Date.now(),
): Promise<CreateMaterialFolderOutcome> {
  const name = input.name.trim();
  const check = validateFolderName(name);
  if (!check.ok) return { status: 'invalid_name', reason: check.kind };
  return persistence.withTransaction(async (tx) => {
    const ownerId = await fence(tx, input.ownerId, input.fence);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      folderCreationLockKey(ownerId),
    ]);
    const existing = await tx.query<FolderRow>(
      `SELECT id, name, created_at, updated_at FROM material_folders
        WHERE owner_id = $1 AND normalized_name = $2`,
      [ownerId, normalizedFolderName(name)],
    );
    if (existing.rows[0]) {
      return { status: 'ok' as const, folder: folderOf(existing.rows[0]), created: false };
    }
    const count = await tx.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM material_folders WHERE owner_id = $1',
      [ownerId],
    );
    if (Number(count.rows[0]?.count ?? 0) >= FOLDER_COUNT_LIMIT) {
      return { status: 'limit' as const, limit: FOLDER_COUNT_LIMIT };
    }
    const inserted = await tx.query<FolderRow>(
      `INSERT INTO material_folders (owner_id, id, name, normalized_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING id, name, created_at, updated_at`,
      [ownerId, randomUUID(), name, normalizedFolderName(name), now],
    );
    return { status: 'ok' as const, folder: folderOf(inserted.rows[0]!), created: true };
  });
}

export type RenameMaterialFolderOutcome =
  | { status: 'renamed' | 'unchanged'; folder: MaterialFolder }
  | FolderNameRefusal
  | { status: 'not_found' }
  | { status: 'name_taken' };

/** Rename a folder. The same name is `unchanged`; another folder's name is `name_taken`. */
export async function renameMaterialFolder(
  persistence: { withTransaction: WithTransaction },
  input: { ownerId: string; folderId: string; name: string; fence: LibraryFence },
  now: number = Date.now(),
): Promise<RenameMaterialFolderOutcome> {
  const name = input.name.trim();
  const check = validateFolderName(name);
  if (!check.ok) return { status: 'invalid_name', reason: check.kind };
  try {
    return await persistence.withTransaction(async (tx) => {
      const ownerId = await fence(tx, input.ownerId, input.fence);
      // Serialize names with creation before taking a folder row lock: a
      // create must see this rename, rather than fail its unique constraint.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        folderCreationLockKey(ownerId),
      ]);
      const current = await tx.query<FolderRow>(
        `SELECT id, name, created_at, updated_at FROM material_folders
          WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
        [ownerId, input.folderId],
      );
      const row = current.rows[0];
      if (!row) return { status: 'not_found' as const };
      if (row.name === name) return { status: 'unchanged' as const, folder: folderOf(row) };
      const updated = await tx.query<FolderRow>(
        `UPDATE material_folders SET name = $3, normalized_name = $4, updated_at = $5
          WHERE owner_id = $1 AND id = $2
          RETURNING id, name, created_at, updated_at`,
        [ownerId, input.folderId, name, normalizedFolderName(name), now],
      );
      return { status: 'renamed' as const, folder: folderOf(updated.rows[0]!) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: 'name_taken' };
    throw error;
  }
}

export type DeleteMaterialFolderOutcome =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'not_empty'; materialCount: number };

/**
 * Delete a folder only while it holds no live material (see the module
 * docstring for the race with a move into it). Page-only: no agent tool
 * calls this.
 */
export async function deleteEmptyMaterialFolder(
  persistence: { withTransaction: WithTransaction },
  input: { ownerId: string; folderId: string; fence: LibraryFence },
): Promise<DeleteMaterialFolderOutcome> {
  return persistence.withTransaction(async (tx) => {
    const ownerId = await fence(tx, input.ownerId, input.fence);
    const folder = await tx.query<{ id: string }>(
      'SELECT id FROM material_folders WHERE owner_id = $1 AND id = $2 FOR UPDATE',
      [ownerId, input.folderId],
    );
    if (!folder.rows[0]) return { status: 'not_found' as const };
    const live = await tx.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM owner_material
        WHERE owner_id = $1 AND folder_id = $2 AND deleted_at IS NULL`,
      [ownerId, input.folderId],
    );
    const materialCount = Number(live.rows[0]?.count ?? 0);
    if (materialCount > 0) return { status: 'not_empty' as const, materialCount };
    // Tombstones keep their row but no longer their folder.
    await tx.query(
      `UPDATE owner_material SET folder_id = NULL
        WHERE owner_id = $1 AND folder_id = $2 AND deleted_at IS NOT NULL`,
      [ownerId, input.folderId],
    );
    await tx.query('DELETE FROM material_folders WHERE owner_id = $1 AND id = $2', [
      ownerId,
      input.folderId,
    ]);
    return { status: 'deleted' as const };
  });
}

export type MoveMaterialsOutcome =
  | {
      status: 'moved' | 'unchanged';
      materialIds: string[];
      folderId: string | null;
      /** How many of the sources named actually changed folder (derivatives not counted). */
      movedCount: number;
    }
  | { status: 'folder_not_found' }
  /** Ids that are missing, another owner's, deleted, not ready, or derivatives. */
  | { status: 'not_movable'; materialIds: string[] }
  | { status: 'too_many'; limit: number };

/**
 * Move sources, with their derivatives, into a folder (`null`: Unfiled).
 * All or nothing: one id that cannot move refuses the whole call and changes
 * nothing. Moving into the folder a source is already in is `unchanged`.
 */
export async function moveMaterials(
  persistence: { withTransaction: WithTransaction },
  input: {
    ownerId: string;
    materialIds: readonly string[];
    folderId: string | null;
    fence: LibraryFence;
  },
): Promise<MoveMaterialsOutcome> {
  const ids = [...new Set(input.materialIds)];
  if (ids.length > MAX_MOVE_MATERIALS) return { status: 'too_many', limit: MAX_MOVE_MATERIALS };
  if (ids.length === 0) {
    return { status: 'unchanged', materialIds: [], folderId: input.folderId, movedCount: 0 };
  }
  return persistence.withTransaction(async (tx) => {
    const ownerId = await fence(tx, input.ownerId, input.fence);
    if (input.folderId !== null) {
      // Held to commit: a deletion of the folder waits, and then sees the move.
      const folder = await tx.query(
        'SELECT id FROM material_folders WHERE owner_id = $1 AND id = $2 FOR KEY SHARE',
        [ownerId, input.folderId],
      );
      if (folder.rows.length === 0) return { status: 'folder_not_found' as const };
    }
    const locked = await tx.query<{
      id: string;
      owner_id: string;
      derived_from: string | null;
      status: string;
      deleted_at: unknown;
      folder_id: string | null;
    }>(
      `SELECT id, owner_id, derived_from, status, deleted_at, folder_id FROM owner_material
        WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    const byId = new Map(locked.rows.map((row) => [row.id, row]));
    const refused = ids.filter((id) => {
      const row = byId.get(id);
      return (
        !row ||
        row.owner_id !== ownerId ||
        row.deleted_at !== null ||
        row.status !== 'ready' ||
        row.derived_from !== null
      );
    });
    if (refused.length > 0) return { status: 'not_movable' as const, materialIds: refused };
    // The sources and every row derived from them, read after the sources'
    // locks: no publication can add a derivative now (module docstring).
    const moved = await tx.query<{ id: string }>(
      `UPDATE owner_material SET folder_id = $3
        WHERE owner_id = $1 AND (id = ANY($2::text[]) OR derived_from = ANY($2::text[]))
          AND folder_id IS DISTINCT FROM $3
        RETURNING id`,
      [ownerId, ids, input.folderId],
    );
    const named = new Set(ids);
    return {
      status: moved.rows.length > 0 ? ('moved' as const) : ('unchanged' as const),
      materialIds: ids,
      folderId: input.folderId,
      movedCount: moved.rows.filter((row) => named.has(row.id)).length,
    };
  });
}

export type RenameMaterialOutcome =
  | { status: 'renamed' | 'unchanged'; materialId: string; name: string }
  | { status: 'invalid_name' }
  /** Missing, another owner's, deleted or not ready. */
  | { status: 'not_found' }
  | { status: 'derivative' };

/**
 * Rename a source: its display name, leaving the original filename as it
 * was uploaded. A derivative is named after its source and is not renamed on
 * its own. The name it already shows is `unchanged`.
 */
export async function renameMaterial(
  persistence: { withTransaction: WithTransaction },
  input: { ownerId: string; materialId: string; name: string; fence: LibraryFence },
): Promise<RenameMaterialOutcome> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MATERIAL_NAME_MAX_LENGTH) {
    return { status: 'invalid_name' };
  }
  return persistence.withTransaction(async (tx) => {
    const ownerId = await fence(tx, input.ownerId, input.fence);
    const current = await tx.query<{
      owner_id: string;
      derived_from: string | null;
      status: string;
      deleted_at: unknown;
      display_name: string | null;
      original_name: string | null;
    }>(
      `SELECT owner_id, derived_from, status, deleted_at, display_name, original_name
         FROM owner_material WHERE id = $1 FOR UPDATE`,
      [input.materialId],
    );
    const row = current.rows[0];
    if (!row || row.owner_id !== ownerId || row.deleted_at !== null || row.status !== 'ready') {
      return { status: 'not_found' as const };
    }
    if (row.derived_from !== null) return { status: 'derivative' as const };
    if ((row.display_name ?? row.original_name) === name) {
      return { status: 'unchanged' as const, materialId: input.materialId, name };
    }
    await tx.query('UPDATE owner_material SET display_name = $2 WHERE id = $1', [
      input.materialId,
      name,
    ]);
    return { status: 'renamed' as const, materialId: input.materialId, name };
  });
}

/** What the owner uses of the two quotas the library is held to (RFC #1716 §8). */
export interface OwnerLibraryUsage {
  /** Active sources, uploads in progress included: what upload admission counts. */
  usedCount: number;
  usedBytes: number;
  /** The owner's pool usage, as the pool's quota check counts it. */
  assetUsedBytes: number;
}

/**
 * The owner's usage, each figure computed the way its quota is enforced: the
 * source quota counts sources (derivatives never), the pool quota counts every
 * entry of the owner's partition not yet released -- uploads, extraction
 * outputs, pending allocations and course copies alike, each in full even
 * when the bytes are stored once.
 */
export async function ownerLibraryUsage(
  queryable: Queryable,
  ownerId: string,
  principalKey: string,
): Promise<OwnerLibraryUsage> {
  const sources = await queryable.query<{ count: string; total: string }>(
    `SELECT COUNT(*)::text AS count, COALESCE(SUM(bytes), 0)::text AS total
       FROM owner_material
      WHERE owner_id = $1 AND kind = 'source' AND deleted_at IS NULL`,
    [ownerId],
  );
  const pool = await queryable.query<{ used: string }>(
    `SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS used
       FROM asset_entries AS entries
       JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
      WHERE entries.principal = $1 AND entries.unreferenced_at IS NULL`,
    [principalKey],
  );
  return {
    usedCount: Number(sources.rows[0]?.count ?? 0),
    usedBytes: Number(sources.rows[0]?.total ?? 0),
    assetUsedBytes: Number(pool.rows[0]?.used ?? 0),
  };
}
