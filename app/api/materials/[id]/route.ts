/**
 * GET /api/materials/[id]?sessionId= reads one owned session material in the
 * same public projection the agent tools use. `?scope=owner` reads or deletes
 * one owner-library original without exposing its digest or object key.
 *
 * Materials are session-scoped; the client names the session and the session's
 * owner row is the authorization. A foreign or missing session, and a material
 * id that does not exist or belongs to another session, all answer the same
 * plain 404 (no existence oracle).
 *
 * Session material deletion remains part of the owning Agent Session lifecycle;
 * this route exposes DELETE only for explicit owner scope.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import {
  getSessionMaterial,
  publicMaterialView,
  resolveOwnedSession,
} from '@/lib/server/agent-runtime/session-materials';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';
import { getReadyOwnerMaterial, publicMaterial } from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { deleteOwnedMaterial, isOwnerMaterialId } from '@/lib/server/materials/owner-assets';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const url = new URL(req.url);
  const scope = url.searchParams.get('scope');
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (scope === 'owner') {
    if (sessionId) return apiError('INVALID_REQUEST', 400, 'owner scope does not accept sessionId');
    return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
      const { id } = await params;
      if (!isOwnerMaterialId(id)) return ownerNotFound(responseHeaders);
      const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      const material = await getReadyOwnerMaterial(provider.pool, ownerId, id);
      if (!material) return ownerNotFound(responseHeaders);
      return ownerJson({ material: publicMaterial(material) }, 200, responseHeaders);
    });
  }
  if (scope !== null) return apiError('INVALID_REQUEST', 400, 'unknown material scope');
  if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId is required');

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const session = await resolveOwnedSession(sessionId, ownerId);
    if (!session) return ownerNotFound(responseHeaders);
    const { id } = await params;
    const material = await getSessionMaterial(sessionId, id);
    if (!material) return ownerNotFound(responseHeaders);
    return ownerJson({ material: publicMaterialView(material) }, 200, responseHeaders);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const url = new URL(req.url);
  if (url.searchParams.get('scope') !== 'owner' || url.searchParams.has('sessionId')) {
    return apiError('INVALID_REQUEST', 400, 'DELETE requires owner material scope');
  }
  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    if (!isOwnerMaterialId(id)) return ownerNotFound(responseHeaders);
    try {
      await deleteOwnedMaterial(ownerId, id);
      return new Response(null, { status: 204, headers: responseHeaders });
    } catch {
      const response = apiError('INTERNAL_ERROR', 500, 'material deletion failed');
      for (const [key, value] of responseHeaders) response.headers.append(key, value);
      return response;
    }
  });
}
