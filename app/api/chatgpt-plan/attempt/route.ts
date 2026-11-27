import { ChatGPTPlanError } from '@/lib/server/chatgpt-plan/errors';
import { chatGPTPlanBody, chatGPTPlanRoute } from '@/lib/server/chatgpt-plan/route';
import { chatGPTSignInAttempt } from '@/lib/server/chatgpt-plan/session';

export const runtime = 'nodejs';

/** Only the installation owner can check or cancel a specific sign-in. */
export function POST(request: Request) {
  return chatGPTPlanRoute(request, async () => {
    const { attemptId, cancel } = await chatGPTPlanBody(request);
    if (typeof attemptId !== 'string' || !attemptId) throw new ChatGPTPlanError('invalid-callback');
    return Response.json({
      success: true,
      outcome: await chatGPTSignInAttempt(attemptId, cancel === true),
    });
  });
}
