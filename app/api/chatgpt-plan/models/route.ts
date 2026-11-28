import { APICallError } from 'ai';

import { publicProviderResponse } from '@/lib/server/api-response';
import { ChatGPTPlanError } from '@/lib/server/chatgpt-plan/errors';
import { listChatGPTPlanModels } from '@/lib/server/chatgpt-plan/model';
import { chatGPTPlanRoute } from '@/lib/server/chatgpt-plan/route';

export const runtime = 'nodejs';

/** GET /api/chatgpt-plan/models — the models the connected account offers. */
export function GET(request: Request) {
  return chatGPTPlanRoute(request, async () => {
    try {
      const refresh = new URL(request.url).searchParams.get('refresh') === '1';
      return Response.json({ success: true, models: await listChatGPTPlanModels({ refresh }) });
    } catch (error) {
      // The connection's failures surface as API call errors with fixed messages.
      if (APICallError.isInstance(error) && error.statusCode !== undefined) {
        if (error.cause instanceof ChatGPTPlanError) throw error.cause;
        const provider = publicProviderResponse(error);
        if (provider) return provider;
      }
      throw error;
    }
  });
}
