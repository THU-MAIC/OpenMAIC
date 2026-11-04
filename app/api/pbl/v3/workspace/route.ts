import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import {
  workbenchCommand,
  workbenchView,
  type WorkbenchCommand,
} from '@/lib/server/pbl-v3/workbench';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) throw sandboxInvalid('A learning session is required.');
    return Response.json(await workbenchView(principal, id));
  });
}
export async function POST(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    const body = await sandboxBody(request, 256000);
    if (typeof body.studyId !== 'string') throw sandboxInvalid('A learning session is required.');
    return Response.json(
      await workbenchCommand(principal, body.studyId, body.command as unknown as WorkbenchCommand),
    );
  });
}
