/**
 * GET /api/materials/[id]?sessionId= — one material an owned session
 * reaches (its own row, or a library material its links reach), in the same
 * public projection the list uses.
 *
 * Materials are session-scoped; the client names the session and the session's
 * owner row is the authorization. A foreign or missing session, and a material
 * id the session does not reach, all answer the same plain 404 (no existence
 * oracle).
 *
 * PATCH /api/materials/[id] `{ name }` renames a source of the request
 * owner's library: its display name, keeping the uploaded file name;
 * `unchanged` when it already shows that name. A derivative answers 409
 * `derivative` (it is named after its source); a missing or another owner's
 * material 404. A thin adapter over `lib/persistence/material-library.ts`,
 * which the agent's `rename_material` calls too.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { resolveOwnedSession } from '@/lib/server/agent-runtime/session-materials';
import { resolveMaterial } from '@/lib/server/agent-runtime/material-resolver';
import { sessionScopeMaterialView } from '@/lib/server/materials/library-view';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { renameMaterial } from '@/lib/persistence/material-library';
import {
  jsonObjectBody,
  libraryNotFound,
  libraryPersistence,
  libraryRefusal,
  libraryWriteError,
} from '@/lib/server/materials/library-routes';

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
    const material = await resolveMaterial(sessionId, id);
    if (!material) return ownerNotFound(responseHeaders);
    return ownerJson({ material: sessionScopeMaterialView(material) }, 200, responseHeaders);
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const body = await jsonObjectBody(req);
  if (typeof body?.name !== 'string') {
    return libraryRefusal(400, 'invalid_body', 'name is required', new Headers());
  }
  const name = body.name;
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    try {
      const outcome = await renameMaterial(await libraryPersistence(), {
        ownerId,
        materialId: id,
        name,
        fence: 'request',
      });
      switch (outcome.status) {
        case 'invalid_name':
          return libraryRefusal(400, 'invalid_name', 'The name is empty or too long', headers);
        case 'not_found':
          return libraryNotFound(headers);
        case 'derivative':
          return libraryRefusal(409, 'derivative', 'Rename the source instead', headers);
        default:
          return ownerJson(outcome, 200, headers);
      }
    } catch (error) {
      return libraryWriteError(error, headers);
    }
  });
}
