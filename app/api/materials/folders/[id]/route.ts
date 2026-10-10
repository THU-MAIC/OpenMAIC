/**
 * PATCH/DELETE /api/materials/folders/[id] — rename a material folder, or
 * delete it and move its contents to the top level in one transaction.
 * PATCH returns renamed/unchanged, or 409 name_taken. DELETE returns 204.
 * A missing or another owner's folder answers 404. The agent can rename a
 * folder but never delete one.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { deleteMaterialFolder, renameMaterialFolder } from '@/lib/persistence/material-library';
import { ownerJson, withOwnerResponseHeaders } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  jsonObjectBody,
  libraryNotFound,
  libraryPersistence,
  libraryRefusal,
  libraryWriteError,
} from '@/lib/server/materials/library-routes';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

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
      const outcome = await renameMaterialFolder(await libraryPersistence(), {
        ownerId,
        folderId: id,
        name,
        fence: 'request',
      });
      switch (outcome.status) {
        case 'invalid_name':
          return libraryRefusal(400, `name_${outcome.reason}`, 'Invalid folder name', headers);
        case 'not_found':
          return libraryNotFound(headers);
        case 'name_taken':
          return libraryRefusal(409, 'name_taken', 'Another folder has that name', headers);
        default:
          return ownerJson({ status: outcome.status, folder: outcome.folder }, 200, headers);
      }
    } catch (error) {
      return libraryWriteError(error, headers);
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    try {
      const outcome = await deleteMaterialFolder(await libraryPersistence(), {
        ownerId,
        folderId: id,
        fence: 'request',
      });
      if (outcome.status === 'not_found') return libraryNotFound(headers);
      return withOwnerResponseHeaders(new NextResponse(null, { status: 204 }), headers);
    } catch (error) {
      return libraryWriteError(error, headers);
    }
  });
}
