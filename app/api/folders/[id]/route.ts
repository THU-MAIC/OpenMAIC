/**
 * PATCH /api/folders/[id] — rename { name }
 * DELETE /api/folders/[id]?mode=ungroup|remove — delete a folder
 *
 * `mode=ungroup` (default): the folder is dropped and its courses become
 * unfiled. `mode=remove`: the folder is dropped and the captured member
 * course ids are returned, so the caller can run its own cascade (the
 * workbench deletes the owner courses it captured).
 *
 * Every handler is owner-scoped exactly like the other workbench routes (see
 * `app/api/folders/route.ts`), and the whole family is gated on the
 * configured runtime.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import type { DocumentFolder, DocumentFolderStore } from '@openmaic/storage';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { folderNameErrorResponse } from '@/lib/server/folder-name-errors';
import { validateFolderName } from '@/lib/utils/folder-name-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The wire shape is the reference's `FolderItem`; see `app/api/folders/route.ts`. */
function folderResponse(folder: DocumentFolder, userKey: string) {
  return { ...folder, userKey };
}

function jsonError(status: number, code: string, message: string, headers?: Headers): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

// PATCH /api/folders/[id] — rename { name }.
export async function PATCH(req: NextRequest, { params }: Params) {
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
    const { id } = await params;
    try {
      const store = (await getOwnerScopedDocumentStore(ownerId)) as unknown as DocumentFolderStore;
      // Excluding itself, same case-insensitive rule as create.
      const existing = await store.listFolders();
      const clash = existing.some(
        (folder) => folder.id !== id && folder.name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (clash) {
        return jsonError(
          409,
          'FOLDER_NAME_DUPLICATE',
          'a folder with this name already exists',
          responseHeaders,
        );
      }

      const updated = await store.renameFolder(id, trimmed);
      if (!updated) {
        return jsonError(404, 'FOLDER_NOT_FOUND', 'folder not found', responseHeaders);
      }
      return ownerJson({ folder: folderResponse(updated, ownerId) }, 200, responseHeaders);
    } catch (error) {
      // The rename re-checks the name through the unique index; a duplicate
      // that slipped past the pre-check answers the same 409.
      const nameError = folderNameErrorResponse(error);
      if (nameError) {
        for (const [key, value] of responseHeaders) nameError.headers.append(key, value);
        return nameError;
      }
      console.error(`[Folders] Failed to rename [owner=${ownerId}, id=${id}]:`, error);
      return jsonError(500, 'FOLDER_RENAME_FAILED', 'Failed to rename folder', responseHeaders);
    }
  });
}

// DELETE /api/folders/[id]?mode=ungroup|remove
export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const modeParam = req.nextUrl.searchParams.get('mode');
  const mode: 'ungroup' | 'remove' = modeParam === 'remove' ? 'remove' : 'ungroup';

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    try {
      const store = (await getOwnerScopedDocumentStore(ownerId)) as unknown as DocumentFolderStore;
      const result = await store.deleteFolder(id, mode);
      if (!result) {
        return jsonError(404, 'FOLDER_NOT_FOUND', 'folder not found', responseHeaders);
      }
      return ownerJson({ ok: true, removedStageIds: result.removedStageIds }, 200, responseHeaders);
    } catch (error) {
      console.error(`[Folders] Failed to delete [owner=${ownerId}, id=${id}]:`, error);
      return jsonError(500, 'FOLDER_DELETE_FAILED', 'Failed to delete folder', responseHeaders);
    }
  });
}
