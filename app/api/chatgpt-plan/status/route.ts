import { chatGPTPlanRoute } from '@/lib/server/chatgpt-plan/route';
import { chatGPTPlanStatus } from '@/lib/server/chatgpt-plan/session';

export const runtime = 'nodejs';

/** GET /api/chatgpt-plan/status — whether the provider is offered, and the connection. */
export function GET(request: Request) {
  return chatGPTPlanRoute(request, async () =>
    Response.json({ success: true, status: await chatGPTPlanStatus() }),
  );
}
