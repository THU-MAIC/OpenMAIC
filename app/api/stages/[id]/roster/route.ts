/**
 * GET /api/stages/[id]/roster — who teaches this course: the stage's
 * `agentIds` and `generatedAgentConfigs`, and nothing else.
 *
 * The freshness sync reads it when the stage's revision moves: scene content
 * comes back through `/scenes`, but a roster write (`set_roster`, an edit in
 * another tab) changes only the stage, and a classroom already on screen
 * would keep the teacher it opened with.
 *
 * The stage revision moves on every scene write too, so this runs often: it
 * reads the stage row alone (`loadStage`), never the course's scenes. Same
 * permission boundary as every stage route: the owner-bound store reads a
 * foreign or missing stage as absent, and both answer the identical 404.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { getOwnerScopedDocumentStore } from '@/lib/server/agent-runtime/owner-scoped-documents';
import { ownerJson, ownerNotFound } from '@/lib/server/agent-runtime/route-response';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    const store = await getOwnerScopedDocumentStore(ownerId);
    const stage = await store.loadStage(id);
    if (!stage) return ownerNotFound(responseHeaders);
    const { agentIds, generatedAgentConfigs } = stage;
    return ownerJson(
      {
        ...(agentIds ? { agentIds } : {}),
        ...(generatedAgentConfigs ? { generatedAgentConfigs } : {}),
      },
      200,
      responseHeaders,
    );
  });
}
