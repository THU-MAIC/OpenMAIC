/**
 * GET /api/materials/[id] — one of the caller's own library uploads (the ids
 * `POST /api/materials` returns) with its extraction: `idle`, `extracting`,
 * `ready` (with what it found and what a course would leave out of it), or
 * `failed` (with the extractor's error). Needs only server persistence; an id
 * the owner does not have answers a plain 404.
 *
 * GET /api/materials/[id]?sessionId= — one owned session's material, in the
 * same public projection the list and the agent's `list_materials` tool use.
 *
 * Materials are session-scoped; the client names the session and the session's
 * owner row is the authorization. A foreign or missing session, and a material
 * id that does not exist or belongs to another session, all answer the same
 * plain 404 (no existence oracle). Session materials live with the agent
 * runtime, so the read sits behind its gate.
 *
 * DELETE /api/materials/[id] — delete one of the caller's own library uploads
 * (the ids `POST /api/materials` returns), releasing its quota, with its
 * extraction result; an extraction still running is dropped. It needs only
 * server persistence. Session material rows are not deletable: an agent
 * session keeps its own copy of a bound upload, and binding a deleted id
 * fails as unavailable.
 */
import type { NextRequest } from 'next/server';

import {
  isAgentRuntimeConfigured,
  isServerPersistenceConfigured,
} from '@/lib/config/feature-flags';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  deleteOwnerMaterial,
  getOwnerMaterial,
  publicMaterial,
} from '@/lib/persistence/owner-materials';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { deleteMaterialObjects, getMaterialByteStore } from '@/lib/server/materials/bytes';
import { isMaterialId } from '@/lib/server/materials/material-id';
import {
  getSessionMaterial,
  publicMaterialView,
  resolveOwnedSession,
} from '@/lib/server/agent-runtime/session-materials';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const sessionId = new URL(req.url).searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
    return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
      const { id } = await params;
      if (!isMaterialId(id)) return ownerNotFound(responseHeaders);
      const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      const record = await getOwnerMaterial(provider.pool, ownerId, id);
      if (!record) return ownerNotFound(responseHeaders);
      return ownerJson({ material: publicMaterial(record) }, 200, responseHeaders);
    });
  }
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const session = await resolveOwnedSession(sessionId, ownerId);
    if (!session) return ownerNotFound(responseHeaders);
    const { id } = await params;
    const material = await getSessionMaterial(sessionId, id);
    if (!material) return ownerNotFound(responseHeaders);
    return ownerJson({ material: publicMaterialView(material) }, 200, responseHeaders);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    if (!isMaterialId(id)) return ownerNotFound(responseHeaders);
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const byteStore = getMaterialByteStore();
    let deleted: boolean;
    try {
      deleted = await deleteOwnerMaterial(
        provider.pool as unknown as ConnectableQueryable,
        ownerId,
        id,
        (ossKey) => deleteMaterialObjects(byteStore, ossKey),
      );
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      throw error;
    }
    if (!deleted) return ownerNotFound(responseHeaders);
    return ownerJson({ materialId: id, deleted: true }, 200, responseHeaders);
  });
}
