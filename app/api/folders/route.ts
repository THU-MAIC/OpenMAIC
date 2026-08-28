/**
 * GET/POST /api/folders — the workbench's course-folder API (server-side
 * counterpart of the local `lib/utils/stage-storage.ts` folder API; the
 * configured runtime routes the seam through these handlers instead of the
 * Dexie tables).
 *
 * Every handler is owner-scoped exactly like the other workbench routes: the
 * owner resolves from the anonymous cookie (`withRequestOwnerId`) and is never
 * a request parameter, and all reads and writes go through the owner-bound
 * document store (`getOwnerScopedDocumentStore`), the same seam the runner
 * binds for the stage tools. A folder created here is visible to this browser
 * and to nobody else.
 *
 * Name validation is the shared display-width rule (full-width = 2, half-width
 * = 1, ≤ 40) from `lib/utils/folder-name-validation.ts` — the same module the
 * client dialogs import, so the two ends cannot drift.
 *
 * The configured runtime gates the whole family (see `app/api/stages/route.ts`):
 * off, or on without a DATABASE_URL, answers the same plain 404.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import type { DocumentFolder, DocumentFolderStore } from '@openmaic/storage';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { folderNameErrorResponse } from '@/lib/server/folder-name-errors';
import { createFolderForOwner, listFoldersForOwner } from '@/lib/server/folder-persistence';
import { validateFolderName } from '@/lib/utils/folder-name-validation';

export const runtime = 'nodejs';

/**
 * The wire shape is the reference's `FolderItem`: the owner id the folder
 * belongs to (its `userKey`) plus the stored row. The owner-bound store is
 * partitioned by `owner_id`, which is exactly the reference's `user_key`, so
 * the request owner IS the folder's user key.
 */
function folderResponse(folder: DocumentFolder, userKey: string) {
  return { ...folder, userKey };
}

/** The reference's error envelope: `{ error: { code, message } }`. */
function jsonError(status: number, code: string, message: string, headers?: Headers): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

// GET /api/folders — list the caller's folders, ordered by `order` asc.
export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const store = (await getOwnerScopedDocumentStore(ownerId)) as unknown as DocumentFolderStore;
      const folders = await listFoldersForOwner(store);
      return ownerJson(
        { folders: folders.map((folder) => folderResponse(folder, ownerId)) },
        200,
        responseHeaders,
      );
    } catch (error) {
      console.error(`[Folders] Failed to list [owner=${ownerId}]:`, error);
      return jsonError(500, 'FOLDER_LIST_FAILED', 'Failed to list folders', responseHeaders);
    }
  });
}

// POST /api/folders — create a folder { name }.
//
// Validation happens before owner resolution, like the stage routes: a
// malformed body must not mint an anonymous cookie partition for a request
// that will not proceed.
export async function POST(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'INVALID_BODY', 'request body must be JSON');
  }
  const name = (body as { name?: unknown })?.name;
  if (typeof name !== 'string') {
    return jsonError(400, 'FOLDER_NAME_INVALID', 'name must be a string');
  }
  const trimmed = name.trim();
  const check = validateFolderName(trimmed);
  if (!check.ok) {
    return jsonError(
      400,
      check.kind === 'empty' ? 'FOLDER_NAME_EMPTY' : 'FOLDER_NAME_TOO_LONG',
      check.kind === 'empty' ? 'folder name must not be empty' : 'folder name is too long',
    );
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const store = (await getOwnerScopedDocumentStore(ownerId)) as unknown as DocumentFolderStore;
      const { folder } = await createFolderForOwner(store, trimmed, { reuseExisting: false });
      return ownerJson({ folder: folderResponse(folder, ownerId) }, 200, responseHeaders);
    } catch (error) {
      // The storage re-checks duplicates + count limit inside its owner-scoped
      // transaction; map its refusals onto the same machine codes the
      // pre-checks use.
      const nameError = folderNameErrorResponse(error);
      if (nameError) {
        for (const [key, value] of responseHeaders) nameError.headers.append(key, value);
        return nameError;
      }
      console.error(`[Folders] Failed to create [owner=${ownerId}]:`, error);
      return jsonError(500, 'FOLDER_CREATE_FAILED', 'Failed to create folder', responseHeaders);
    }
  });
}
