/**
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
 * (the ids `POST /api/materials` returns), releasing its quota. It needs only
 * server persistence. Session material rows are not deletable: an agent
 * session keeps its own copy of a bound upload, and binding a deleted id
 * fails as unavailable.
 */
import type { NextRequest } from 'next/server';

import {
  isAgentRuntimeConfigured,
  isServerPersistenceConfigured,
} from '@/lib/config/feature-flags';
import { deleteOwnerMaterial } from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { getMaterialByteStore } from '@/lib/server/materials/bytes';
import { apiError } from '@/lib/server/api-response';
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
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const sessionId = new URL(req.url).searchParams.get('sessionId')?.trim();
  if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId is required');

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
    const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
    const byteStore = getMaterialByteStore();
    const deleted = await deleteOwnerMaterial(provider.pool, ownerId, id, (ossKey) =>
      byteStore.delete(ossKey),
    );
    if (!deleted) return ownerNotFound(responseHeaders);
    return ownerJson({ materialId: id, deleted: true }, 200, responseHeaders);
  });
}
