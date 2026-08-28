/**
 * GET /api/stages/[id]/scenes?ids=a,b,c — batch scene read (reference
 * `stages/:id/scenes`, ported onto the owner-bound document store).
 *
 * Returns ONLY the requested scenes, in document (`scene_order`) order — the
 * narrow re-fetch half of the workbench's manifest sync: the client diffs
 * `GET /api/stages/:id/manifest` against what it rendered with, then asks
 * this endpoint for exactly the scene ids whose rev changed. One page commit
 * therefore moves one scene instead of the whole document.
 *
 * Ownership and existence share the store's no-existence-oracle posture: the
 * owner-bound store reads a foreign or missing stage as absent, and both
 * answer the identical 404. A requested id that does not exist (deleted
 * between the manifest read and here) is simply absent from the array.
 *
 * Ids are bounded: a pathological diff could name every scene, so the request
 * is capped at MAX_BATCH_SCENE_IDS; over the cap is a 400 rather than a
 * silent truncation (truncating would drop scenes the client believes it
 * fetched). The client treats 400 as a failed pass and retries on the next
 * trigger.
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { apiError } from '@/lib/server/api-response';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

/** Upper bound on `ids` — see the file header. */
export const MAX_BATCH_SCENE_IDS = 200;

/**
 * Scene ids travel the same wire as stage ids, so they face the same driver
 * hazard: a `\0` or a lone surrogate in the query parameter would make an id
 * comparison throw at the driver. Such an id can never match a stored scene,
 * so dropping it is exact (reference rationale).
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
function isQueryableSceneId(sceneId: string): boolean {
  return !sceneId.includes('\u0000') && !LONE_SURROGATE.test(sceneId);
}

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  const rawIds = new URL(req.url).searchParams.get('ids');
  const requested = (rawIds ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    // Dedupe: a repeated id is the same scene; counting it twice would also
    // inflate the bound check.
    .filter((value, index, all) => all.indexOf(value) === index)
    .filter(isQueryableSceneId);
  if (requested.length === 0) {
    return apiError('INVALID_REQUEST', 400, 'empty_scene_ids');
  }
  if (requested.length > MAX_BATCH_SCENE_IDS) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'too_many_scene_ids',
      `limit ${MAX_BATCH_SCENE_IDS}, requested ${requested.length}`,
    );
  }

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    const store = await getOwnerScopedDocumentStore(ownerId);
    const document = await store.loadDocument(id);
    if (!document) return ownerNotFound(responseHeaders);
    const wanted = new Set(requested);
    const scenes = document.scenes.filter((scene) => wanted.has(scene.id));
    return ownerJson({ scenes }, 200, responseHeaders);
  });
}
