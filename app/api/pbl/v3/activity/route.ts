import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import { LearningStore } from '@/lib/server/pbl-v3/store';
import { SandboxService } from '@/lib/server/sandbox/service';

export const runtime = 'nodejs';

/** A coalesced user-input signal. Never allocates compute or advances teaching progress. */
export function POST(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const body = await sandboxBody(request);
    if (typeof body.stageId !== 'string' || typeof body.sceneId !== 'string')
      throw sandboxInvalid('A classroom and scene are required.');
    await SandboxService.forOwner(principal);
    const store = await LearningStore.open();
    const study = await store.findForScene(principal.ownerId, body.stageId, body.sceneId);
    if (!study) return Response.json({ recorded: false });
    await store.waitForExclusive(study.id, () => store.recordActivity(study.id, principal.ownerId));
    return Response.json({ recorded: true });
  });
}
