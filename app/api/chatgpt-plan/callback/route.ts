import { ChatGPTPlanError } from '@/lib/server/chatgpt-plan/errors';
import { chatGPTPlanBody, chatGPTPlanRoute } from '@/lib/server/chatgpt-plan/route';
import { completeChatGPTSignIn } from '@/lib/server/chatgpt-plan/session';

export const runtime = 'nodejs';

/** POST /api/chatgpt-plan/callback — finish a sign-in with the address the user pasted. */
export function POST(request: Request) {
  return chatGPTPlanRoute(request, async () => {
    const { address } = await chatGPTPlanBody(request);
    if (typeof address !== 'string' || !address.trim()) {
      throw new ChatGPTPlanError('invalid-callback');
    }
    await completeChatGPTSignIn({ address });
    return Response.json({ success: true });
  });
}
