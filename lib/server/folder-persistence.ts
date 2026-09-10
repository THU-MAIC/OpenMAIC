import type { DocumentFolder, DocumentFolderStore } from '@openmaic/storage';
import { randomBytes } from 'node:crypto';

import { FOLDER_COUNT_LIMIT, FolderNameError } from '@/lib/utils/folder-name-validation';

/**
 * The single create/name-idempotency seam used by `/api/folders` and the agent
 * `create_folder` tool, on top of the owner-bound document store.
 *
 * The store is already bound to the request's owner (see
 * `getOwnerScopedDocumentStore`), so — unlike the reference's provider — no
 * owner key travels through these helpers: the owner scope is a property of
 * the store, not a parameter.
 */
export class FolderPersistenceError extends Error {
  constructor(
    message: string,
    readonly folderId: string,
  ) {
    super(message);
    this.name = 'FolderPersistenceError';
  }
}

export async function listFoldersForOwner(folders: DocumentFolderStore): Promise<DocumentFolder[]> {
  return folders.listFolders();
}

/** Mint a fresh, collision-free folder id in the same random family as the stage ids. */
export function createFolderId(): string {
  return `folder-${randomBytes(9).toString('base64url')}`;
}

export interface CreateFolderForOwnerOptions {
  /** Agent retries reuse a same-name row; HTTP creates retain their 409 contract. */
  reuseExisting: boolean;
}

export interface CreateFolderForOwnerResult {
  folder: DocumentFolder;
  reused: boolean;
}

function sameName(folder: DocumentFolder, name: string): boolean {
  return folder.name.toLowerCase() === name.toLowerCase();
}

/**
 * Create a folder under the store's owner, enforcing the reference's contract:
 * a case-insensitive duplicate refuses with `FolderNameError('duplicate')`
 * unless `reuseExisting` (the agent tool's idempotent retry), and the count
 * limit refuses with `FolderNameError('limit')`.
 *
 * A create is not reported as successful until the returned id is readable
 * through the exact list scope used by the tree: besides pinning the PG
 * read-after-write contract, this turns any accidental owner-scope drift into
 * a loud failure instead of a `folder_created` event for a ghost id.
 */
export async function createFolderForOwner(
  folders: DocumentFolderStore,
  name: string,
  options: CreateFolderForOwnerOptions,
): Promise<CreateFolderForOwnerResult> {
  const current = await folders.listFolders();
  const existing = current.find((folder) => sameName(folder, name));
  if (existing) {
    if (options.reuseExisting) return { folder: existing, reused: true };
    throw new FolderNameError('A folder with this name already exists', 'duplicate');
  }
  if (current.length >= FOLDER_COUNT_LIMIT) {
    throw new FolderNameError('Folder count limit reached', 'limit');
  }

  const created = await folders.createFolder(createFolderId(), name, FOLDER_COUNT_LIMIT);
  if (created.reused) {
    // A concurrent create won the name and the idempotent store reused its row
    // (its `reused: true`). HTTP creates keep their 409 contract even for the
    // race their pre-check cannot see.
    if (options.reuseExisting) return { folder: created.folder, reused: true };
    throw new FolderNameError('A folder with this name already exists', 'duplicate');
  }

  const persisted = (await folders.listFolders()).find((folder) => folder.id === created.folder.id);
  if (!persisted) {
    throw new FolderPersistenceError(
      `created folder ${JSON.stringify(created.folder.id)} is not readable in its owner scope`,
      created.folder.id,
    );
  }
  return { folder: persisted, reused: false };
}
