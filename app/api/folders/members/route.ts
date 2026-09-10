/**
 * POST /api/folders/members — set which folder a course belongs to.
 *
 * Body: { stageId: string, folderId: string | null }
 *   folderId = string  → file the course into that folder (must belong to the
 *                        caller, else 404 FOLDER_NOT_FOUND).
 *   folderId = null    → unfile the course (the membership is removed; an
 *                        absent membership already means unfiled, so this is
 *                        idempotent).
 *
 * Membership is a pure (owner, stage) → folder organization row on the
 * document row — deliberately decoupled from the course list itself (the
 * document index is the UI's gate), and `stageId` is a soft reference: the
 * server may delete a stage.
 *
 * Owner-scoped and gated exactly like the rest of the folder family.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import type { DocumentFolderStore } from '@openmaic/storage';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

function jsonError(status: number, code: string, message: string, headers?: Headers): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

// POST /api/folders/members
export async function POST(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'INVALID_BODY', 'request body must be JSON');
  }
  const { stageId, folderId } = (body ?? {}) as { stageId?: unknown; folderId?: unknown };
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return jsonError(400, 'MISSING_STAGE_ID', 'stageId must be a non-empty string');
  }
  if (folderId !== null && (typeof folderId !== 'string' || folderId.length === 0)) {
    return jsonError(400, 'INVALID_FOLDER_ID', 'folderId must be a non-empty string or null');
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    try {
      const store = (await getOwnerScopedDocumentStore(ownerId)) as unknown as DocumentFolderStore;
      const ok = await store.setStageFolder(stageId, folderId);
      if (!ok) {
        return jsonError(404, 'FOLDER_NOT_FOUND', 'folder not found', responseHeaders);
      }
      return ownerJson({ ok: true }, 200, responseHeaders);
    } catch (error) {
      console.error(
        `[Folders] Failed to set membership [owner=${ownerId}, stage=${stageId}]:`,
        error,
      );
      return jsonError(
        500,
        'FOLDER_MEMBER_FAILED',
        'Failed to set folder membership',
        responseHeaders,
      );
    }
  });
}
