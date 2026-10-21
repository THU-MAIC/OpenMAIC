import { usesClassicExtraction } from '@/lib/persistence/material-extraction-format';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
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
 *
 * DELETE /api/materials/[id] deletes the request owner's ready source and
 * its derivatives atomically (204, no body). Missing, foreign, uploading
 * and deleted rows answer 404; a derivative answers 409 `derivative`. The
 * request fence refuses retired owners (403), and busy writes answer 503
 * with Retry-After. Links become unreadable; conversation text, old session
 * copies and independent course media remain. Legacy originals are cleaned
 * only after commit, with failures retried by a cleanup pass on every start.
 * Page-only: no agent deletion tool and no library event.
 */
import type { NextRequest } from 'next/server';

import {
  isAgentRuntimeConfigured,
  isServerPersistenceConfigured,
} from '@/lib/config/feature-flags';

import {
  publicMaterial,
  touchOwnerMaterial,
  getOwnerMaterial,
} from '@/lib/persistence/owner-materials';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { isMaterialId } from '@/lib/server/materials/material-id';
import { apiError } from '@/lib/server/api-response';
import { resolveOwnedSession } from '@/lib/server/agent-runtime/session-materials';
import { resolveMaterial } from '@/lib/server/agent-runtime/material-resolver';
import { sessionScopeMaterialView } from '@/lib/server/materials/library-view';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { deleteMaterial, renameMaterial } from '@/lib/persistence/material-library';
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
  const searchParams = new URL(req.url).searchParams;
  const sessionId = searchParams.get('sessionId')?.trim();
  // A session named but empty is a mistake, not a request for the library.
  if (searchParams.has('sessionId') && !sessionId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, 'sessionId must not be empty');
  }
  if (!sessionId) {
    if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
    return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
      const { id } = await params;
      if (!isMaterialId(id)) return ownerNotFound(responseHeaders);
      const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      // Reading it says the owner still holds it: the unused-upload sweep
      // counts its age from now.
      const record = await touchOwnerMaterial(provider.pool, ownerId, id);
      if (!record) return ownerNotFound(responseHeaders);
      return ownerJson({ material: publicMaterial(record) }, 200, responseHeaders);
    });
  }
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

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

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    try {
      const persistence = await libraryPersistence();
      const record = await persistence.withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return getOwnerMaterial(tx, ownerId, id);
      });
      if (!record) return libraryNotFound(headers);
      const classic = usesClassicExtraction(record);
      if (!classic && !isAgentRuntimeConfigured())
        return new Response('Not found', { status: 404, headers });
      const outcome = await deleteMaterial(persistence, {
        ownerId,
        materialId: id,
        fence: 'request',
      });
      switch (outcome.status) {
        case 'not_found':
          return libraryNotFound(headers);
        case 'derivative':
          return libraryRefusal(409, 'derivative', 'Delete the source instead', headers);
        case 'deleted':
          return classic
            ? ownerJson({ materialId: id, deleted: true }, 200, headers)
            : new Response(null, { status: 204, headers });
      }
    } catch (error) {
      return libraryWriteError(error, headers);
    }
  });
}
