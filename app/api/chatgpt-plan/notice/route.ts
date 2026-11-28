import { chatGPTPlanRoute } from '@/lib/server/chatgpt-plan/route';
import { acknowledgeChatGPTPlanNotice } from '@/lib/server/chatgpt-plan/session';

export const runtime = 'nodejs';

/** POST /api/chatgpt-plan/notice — the owner read the notice about plan usage. */
export function POST(request: Request) {
  return chatGPTPlanRoute(request, async () => {
    await acknowledgeChatGPTPlanNotice();
    return Response.json({ success: true });
  });
}
