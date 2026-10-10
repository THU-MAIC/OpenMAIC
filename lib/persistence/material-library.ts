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
 * A move locks the sources (one ascending statement, which skips every
 * derivative named: `derived_from` never changes, so a derivative is never
 * locked and is refused as not movable), then updates the sources and every
 * row derived from them. A publication inserts a source's
 * derivatives only while it holds that source's lock, so once the move holds
 * it, the set of derivatives is complete and stays so until the move commits:
 * none can be published into the old folder behind it.
 *
 * ## Deleting a source
 *
 * A page-only deletion locks the source, then reads and locks its live
 * derivatives in the next statement. Publications require that source's lock,
 * so the set is complete and stays fixed until deletion commits. The transaction
 * withdraws the actual roots and tombstones the source and its derivatives.
 *
 * Every writer takes a source before any of its derivatives: publications,
 * moves (which never lock a derivative they are given) and deletion. A rename
 * locks only the row it names, and attach locks sources only, so no writer
 * holds a derivative while it waits for its source, and deletion cannot wait
 * in a cycle with any of them.
 *
 * ## Deleting a folder
 *
 * Deletion holds the folder FOR NO KEY UPDATE, blocking moves into it (FOR
 * SHARE) while allowing extraction's foreign-key checks (FOR KEY SHARE).
 * It then locks sources in id order before updating any derivatives, clears
 * all filing and deletes the folder in the same transaction. Publications
 * that finish first are included; later publications read the cleared folder.
 * This avoids holding a folder's FOR UPDATE lock while waiting for a source
 * whose publication needs to check that folder's foreign key.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable, WithTransaction } from '@openmaic/storage/document/pg';

import {
  FOLDER_COUNT_LIMIT,
  validateFolderName,
  type FolderNameValidationError,
} from '@/lib/utils/folder-name-validation';

import { fenceOwnerWrite, forwardOwnerWrite } from './owner-merges';
import { MATERIAL_ROOT_KIND, withMaterialRoots } from './material-roots';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';

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

/** The same live-ready-source count in listings and existing-folder answers. */
function folderMaterialCountSql(): string {
  return `(SELECT COUNT(*) FROM owner_material AS material
              WHERE material.owner_id = folder.owner_id AND material.folder_id = folder.id
                AND material.derived_from IS NULL AND material.deleted_at IS NULL
                AND material.status = 'ready')::text AS material_count`;
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
            ${folderMaterialCountSql()}
       FROM material_folders AS folder
      WHERE folder.owner_id = $1 ${filter}
      ORDER BY folder.normalized_name, folder.id`,
    params,
  );
  return result.rows.map(folderOf);
}

/** Folder names for material listings, without per-folder usage counts. */
export async function listMaterialFolderNames(
  queryable: Queryable,
  ownerId: string,
): Promise<Array<Pick<MaterialFolder, 'id' | 'name'>>> {
  const result = await queryable.query<{ id: string; name: string }>(
    `SELECT id, name FROM material_folders
      WHERE owner_id = $1 ORDER BY normalized_name, id`,
    [ownerId],
  );
  return result.rows;
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
      `SELECT folder.id, folder.name, folder.created_at, folder.updated_at,
              ${folderMaterialCountSql()}
         FROM material_folders AS folder
        WHERE folder.owner_id = $1 AND folder.normalized_name = $2`,
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
        `SELECT folder.id, folder.name, folder.created_at, folder.updated_at,
                ${folderMaterialCountSql()}
           FROM material_folders AS folder
          WHERE folder.owner_id = $1 AND folder.id = $2 FOR UPDATE`,
        [ownerId, input.folderId],
      );
      const row = current.rows[0];
      if (!row) return { status: 'not_found' as const };
      if (row.name === name) return { status: 'unchanged' as const, folder: folderOf(row) };
      const updated = await tx.query<FolderRow>(
        `UPDATE material_folders AS folder SET name = $3, normalized_name = $4, updated_at = $5
          WHERE folder.owner_id = $1 AND folder.id = $2
          RETURNING folder.id, folder.name, folder.created_at, folder.updated_at,
                    ${folderMaterialCountSql()}`,
        [ownerId, input.folderId, name, normalizedFolderName(name), now],
      );
      return { status: 'renamed' as const, folder: folderOf(updated.rows[0]!) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { status: 'name_taken' };
    throw error;
  }
}

export type DeleteMaterialFolderOutcome = { status: 'deleted' } | { status: 'not_found' };

/**
 * Delete a folder and move all its materials to the top level atomically.
 * Source bytes, extraction, derivatives and roots are preserved. Page-only.
 */
export async function deleteMaterialFolder(
  persistence: { withTransaction: WithTransaction },
  input: { ownerId: string; folderId: string; fence: LibraryFence },
): Promise<DeleteMaterialFolderOutcome> {
  return persistence.withTransaction(async (tx) => {
    const ownerId = await fence(tx, input.ownerId, input.fence);
    const folder = await tx.query<{ id: string }>(
      'SELECT id FROM material_folders WHERE owner_id = $1 AND id = $2 FOR NO KEY UPDATE',
      [ownerId, input.folderId],
    );
    if (!folder.rows[0]) return { status: 'not_found' as const };
    // Match move/publication lock order: sources first, then their derivatives.
    // The folder lock prevents new moves into this set while it is acquired.
    await tx.query(
      `SELECT id FROM owner_material
        WHERE owner_id = $1 AND folder_id = $2 AND derived_from IS NULL
        ORDER BY id FOR UPDATE`,
      [ownerId, input.folderId],
    );
    // Includes derivatives published before the source locks, and tombstones.
    await tx.query(
      `UPDATE owner_material SET folder_id = NULL
        WHERE owner_id = $1 AND folder_id = $2`,
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
      // Held to commit: folder deletion waits, then moves these sources out too.
      const folder = await tx.query(
        'SELECT id FROM material_folders WHERE owner_id = $1 AND id = $2 FOR SHARE',
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
        WHERE id = ANY($1::text[]) AND derived_from IS NULL ORDER BY id FOR UPDATE`,
      [ids],
    );
    // A derivative named here is never locked (lock order, module docstring),
    // so it is refused as missing.
    const byId = new Map(locked.rows.map((row) => [row.id, row]));
    const refused = ids.filter((id) => {
      const row = byId.get(id);
      return !row || row.owner_id !== ownerId || row.deleted_at !== null || row.status !== 'ready';
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

/**
 * A ready source's display name, for naming what it is served as; null when
 * it was never renamed. Undefined when the owner has no such ready source.
 */
export async function materialDisplayName(
  queryable: Queryable,
  ownerId: string,
  materialId: string,
): Promise<string | null | undefined> {
  const result = await queryable.query<{ display_name: string | null }>(
    `SELECT display_name FROM owner_material
      WHERE id = $1 AND owner_id = $2 AND status = 'ready' AND deleted_at IS NULL`,
    [materialId, ownerId],
  );
  return result.rows.length === 0 ? undefined : result.rows[0].display_name;
}

export type DeleteMaterialOutcome =
  | { status: 'deleted'; materialIds: string[] }
  | { status: 'not_found' }
  | { status: 'derivative' };

/** Delete a ready source and its derivatives, withdrawing their actual roots atomically. */
export async function deleteMaterial(
  persistence: { pool: Queryable; withTransaction: WithTransaction },
  input: { ownerId: string; materialId: string; fence: 'request' },
  now: number = Date.now(),
): Promise<DeleteMaterialOutcome> {
  const outcome = await withMaterialRoots(
    persistence,
    { ...input, materialIds: [input.materialId] },
    async ({ tx, ownerId, changeRoots }) => {
      const current = await tx.query<{
        owner_id: string;
        derived_from: string | null;
        status: string;
        deleted_at: unknown;
      }>('SELECT owner_id, derived_from, status, deleted_at FROM owner_material WHERE id = $1', [
        input.materialId,
      ]);
      const row = current.rows[0];
      if (!row || row.owner_id !== ownerId || row.status !== 'ready' || row.deleted_at !== null) {
        return { status: 'not_found' as const };
      }
      if (row.derived_from !== null) return { status: 'derivative' as const };
      // A separate statement after acquiring the source lock sees derivatives
      // committed by a publication we waited for. No publisher can add more
      // while this transaction holds the source.
      const derivatives = await tx.query<{ id: string }>(
        `SELECT id FROM owner_material WHERE derived_from = $1 AND deleted_at IS NULL
          ORDER BY id FOR UPDATE`,
        [input.materialId],
      );
      const materialIds = [input.materialId, ...derivatives.rows.map((item) => item.id)];
      const roots = await tx.query<{ root_id: string; asset_id: string }>(
        `SELECT root_id, asset_id FROM asset_root_refs
          WHERE root_kind = $1 AND root_id = ANY($2::text[]) ORDER BY root_id, asset_id`,
        [MATERIAL_ROOT_KIND, materialIds],
      );
      const byRoot = new Map<string, string[]>();
      for (const root of roots.rows) {
        const assets = byRoot.get(root.root_id) ?? [];
        assets.push(root.asset_id);
        byRoot.set(root.root_id, assets);
      }
      if (byRoot.size > 0) {
        await changeRoots({
          remove: [...byRoot].map(([materialId, assetIds]) => ({ materialId, assetIds })),
        });
      }
      await tx.query('UPDATE owner_material SET deleted_at = $2 WHERE id = ANY($1::text[])', [
        materialIds,
        now,
      ]);
      return { status: 'deleted' as const, materialIds };
    },
  );
  if (outcome.status === 'deleted') {
    try {
      // Only a committed tombstone authorizes deleting legacy bytes. Failures
      // retain the key for the cleanup pass of the next start
      // (`removeDeletedOriginals`).
      const committed = await persistence.pool.query<{ oss_key: string }>(
        `SELECT oss_key FROM owner_material
          WHERE id = $1 AND deleted_at IS NOT NULL AND oss_key <> ''`,
        [input.materialId],
      );
      const key = committed.rows[0]?.oss_key;
      if (key) {
        await getMaterialByteStore().delete(key);
        await persistence.pool.query(
          `UPDATE owner_material SET oss_key = ''
            WHERE id = $1 AND deleted_at IS NOT NULL AND oss_key = $2`,
          [input.materialId, key],
        );
      }
    } catch (error) {
      console.warn(
        `[material-delete] old original for material ${input.materialId} left for the next cleanup pass`,
        error,
      );
    }
  }
  return outcome;
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
