import { chatGPTPlanRoute } from '@/lib/server/chatgpt-plan/route';
import { forgetChatGPTRegistration } from '@/lib/server/chatgpt-plan/session';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return chatGPTPlanRoute(request, async () => {
    await forgetChatGPTRegistration();
    return Response.json({ success: true });
  });
}
