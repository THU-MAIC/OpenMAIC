import { sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxConflict, sandboxInvalid } from '@/lib/sandbox/errors';
import { LearningStore } from '@/lib/server/pbl-v3/store';
import { SandboxService } from '@/lib/server/sandbox/service';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const params = new URL(request.url).searchParams,
      id = params.get('id'),
      env = params.get('environmentId'),
      terminal = params.get('terminalId');
    if (!id || !env || !terminal)
      throw sandboxInvalid('A learning session, environment and terminal are required.');
    const row = await (await LearningStore.open()).get(id, principal.ownerId);
    if (row.environment_id !== env) throw sandboxConflict('The learning environment changed.');
    const service = await SandboxService.forOwner(principal);
    return new Response(await service.terminalStream(env, terminal, request.signal), {
      headers: { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' },
    });
  });
}
