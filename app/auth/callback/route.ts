import type { NextRequest } from 'next/server';
import { ChatGPTPlanError } from '@/lib/server/chatgpt-plan/errors';
import { callbackPage } from '@/lib/server/chatgpt-plan/route';
import { completeChatGPTSignIn } from '@/lib/server/chatgpt-plan/session';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';

const log = createLogger('ChatGPT Plan');

/**
 * GET /auth/callback — where ChatGPT returns a browser on this machine after
 * sign-in (`http://127.0.0.1:<port>/auth/callback`). That origin has none of
 * the app's cookies: the sign-in's single-use `state` is what authorizes it.
 */
export async function GET(request: NextRequest) {
  try {
    const presentation = await completeChatGPTSignIn({
      params: new URL(request.url).searchParams,
    });
    return callbackPage(request, { ok: true, ...presentation });
  } catch (error) {
    if (!(error instanceof ChatGPTPlanError)) log.error('ChatGPT sign-in callback failed:', error);
    else if (error.code === 'upstream' || error.code === 'sign-in-failed') {
      log.warn('ChatGPT sign-in callback failed:', error);
    }
    return callbackPage(request, {
      ok: false,
      ...(error instanceof ChatGPTPlanError && { reason: error.code, locale: error.locale }),
    });
  }
}
