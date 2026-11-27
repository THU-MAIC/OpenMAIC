import { APICallError } from 'ai';

import { apiError } from '@/lib/server/api-response';
import { ChatGPTPlanError } from '@/lib/server/chatgpt-plan/errors';
import { listChatGPTPlanModels } from '@/lib/server/chatgpt-plan/model';
import { chatGPTPlanRoute } from '@/lib/server/chatgpt-plan/route';

export const runtime = 'nodejs';

/** GET /api/chatgpt-plan/models — the models the connected account offers. */
export function GET(request: Request) {
  return chatGPTPlanRoute(request, async () => {
    try {
      return Response.json({ success: true, models: await listChatGPTPlanModels() });
    } catch (error) {
      // The connection's failures surface as API call errors with fixed messages.
      if (APICallError.isInstance(error) && error.statusCode !== undefined) {
        if (error.cause instanceof ChatGPTPlanError) throw error.cause;
        return apiError('UPSTREAM_ERROR', error.statusCode, error.message);
      }
      throw error;
    }
  });
}
