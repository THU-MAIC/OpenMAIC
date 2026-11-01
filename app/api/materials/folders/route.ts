/**
 * GET/POST /api/materials/folders — the material library's folders.
 *
 * GET lists the request owner's folders by name, each with how many live
 * sources it holds (`?query=` matches names literally). POST `{ name }`
 * creates one, or answers the owner's folder of the same name with
 * `created: false`. Thin adapters over `lib/persistence/material-library.ts`,
 * which the agent's folder tools call too; names follow course folders.
 *
 * Gated like the rest of `/api/materials`: without the configured agent
 * runtime it answers a plain 404.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { createMaterialFolder, listMaterialFolders } from '@/lib/persistence/material-library';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  jsonObjectBody,
  libraryPersistence,
  libraryRefusal,
  libraryWriteError,
} from '@/lib/server/materials/library-routes';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const query = new URL(req.url).searchParams.get('query')?.trim() || undefined;
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const folders = await listMaterialFolders((await libraryPersistence()).pool, ownerId, {
      ...(query ? { query } : {}),
    });
    return ownerJson({ folders }, 200, headers);
  });
}

export async function POST(req: NextRequest) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });
  const body = await jsonObjectBody(req);
  if (typeof body?.name !== 'string') {
    return libraryRefusal(400, 'invalid_body', 'name is required', new Headers());
  }
  const name = body.name;
  return withRequestOwner(req, async ({ ownerId }, headers) => {
    try {
      const outcome = await createMaterialFolder(await libraryPersistence(), {
        ownerId,
        name,
        fence: 'request',
      });
      if (outcome.status === 'invalid_name') {
        return libraryRefusal(400, `name_${outcome.reason}`, 'Invalid folder name', headers);
      }
      if (outcome.status === 'limit') {
        return libraryRefusal(409, 'limit', `At most ${outcome.limit} folders`, headers);
      }
      return ownerJson(
        { folder: outcome.folder, created: outcome.created },
        outcome.created ? 201 : 200,
        headers,
      );
    } catch (error) {
      return libraryWriteError(error, headers);
    }
  });
}
