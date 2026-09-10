/**
 * GET /api/materials/[id]?sessionId= — one owned session's material, in the
 * same public projection the list and the agent's `list_materials` tool use.
 *
 * Materials are session-scoped; the client names the session and the session's
 * owner row is the authorization. A foreign or missing session, and a material
 * id that does not exist or belongs to another session, all answer the same
 * plain 404 (no existence oracle).
 *
 * Deletion is deliberately not exposed: the session-material store from the
 * materials slice has no delete operation, and this slice adds no persistence
 * — a later slice grows deletion on the store, then the route.
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

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const sessionId = new URL(req.url).searchParams.get('sessionId')?.trim();
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
