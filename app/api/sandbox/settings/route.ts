import { sandboxBody, sandboxPrincipalResponse } from '@/lib/server/sandbox/http';
import {
  assertSandboxSettingsAdmin,
  sandboxSettingsView,
  saveSandboxSettings,
} from '@/lib/server/sandbox/settings';
export const runtime = 'nodejs';
export function GET(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    assertSandboxSettingsAdmin(principal);
    return Response.json({ success: true, data: await sandboxSettingsView() });
  });
}
export function PUT(request: Request) {
  return sandboxPrincipalResponse(request, async (principal) => {
    assertSandboxSettingsAdmin(principal);
    return Response.json({
      success: true,
      data: await saveSandboxSettings(await sandboxBody(request, 8192)),
    });
  });
}
