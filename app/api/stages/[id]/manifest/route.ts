/**
 * GET /api/stages/[id]/manifest — freshness manifest for one course (the
 * reference's `stages/:id/manifest`, ported onto the owner-bound store).
 *
 * Returns `{rev, scenes: [{id, order, rev}]}` — the per-stage monotonic
 * revision and each scene's own revision, produced by DB triggers on
 * `document_stages` / `document_scenes` (provisioned by the storage package's
 * schema), so every write seam — HTTP routes, agent tools, jobs, manual SQL —
 * moves them without application cooperation. The workbench canvas diffs this
 * manifest against what it rendered with and re-fetches only the scenes whose
 * rev changed.
 *
 * Permission boundary is the same as every stage route: the owner-bound store
 * reads a foreign or missing stage as absent, and both answer the identical
 * 404 (the id is not an existence oracle).
 */
import type { NextRequest } from 'next/server';

import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwnerId } from '@/lib/server/agent-runtime/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isAgentRuntimeConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwnerId(req, async (ownerId, responseHeaders) => {
    const { id } = await params;
    const store = await getOwnerScopedDocumentStore(ownerId);
    const manifest = await store.readFreshnessManifest(id);
    if (!manifest) return ownerNotFound(responseHeaders);
    return ownerJson(manifest, 200, responseHeaders);
  });
}
