import type { NextRequest } from 'next/server';
import { chatGPTPlanRoute, requestLocale } from '@/lib/server/chatgpt-plan/route';
import { beginChatGPTSignIn } from '@/lib/server/chatgpt-plan/session';

export const runtime = 'nodejs';

/**
 * POST /api/chatgpt-plan/sign-in — start a sign-in. The browser's origin
 * decides whether it can return to this server on its own.
 */
export function POST(request: NextRequest) {
  return chatGPTPlanRoute(request, async () =>
    Response.json({
      success: true,
      signIn: await beginChatGPTSignIn(
        request.headers.get('origin') ?? undefined,
        requestLocale(request),
      ),
    }),
  );
}
