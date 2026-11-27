import { chatGPTPlanRoute } from '@/lib/server/chatgpt-plan/route';
import { disconnectChatGPT } from '@/lib/server/chatgpt-plan/session';

export const runtime = 'nodejs';

/**
 * POST /api/chatgpt-plan/disconnect — revoke the connection and forget the
 * account. `revoked: false` means OpenAI did not confirm the revocation.
 */
export function POST(request: Request) {
  return chatGPTPlanRoute(request, async () =>
    Response.json({ success: true, ...(await disconnectChatGPT()) }),
  );
}
