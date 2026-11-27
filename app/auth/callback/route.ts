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
export async function GET(request: Request) {
  try {
    const { returnTo } = await completeChatGPTSignIn({
      params: new URL(request.url).searchParams,
    });
    return callbackPage({ ok: true, ...(returnTo ? { returnTo } : {}) });
  } catch (error) {
    if (!(error instanceof ChatGPTPlanError)) log.error('ChatGPT sign-in callback failed:', error);
    else if (error.code === 'upstream' || error.code === 'sign-in-failed') {
      log.warn('ChatGPT sign-in callback failed:', error);
    }
    return callbackPage({
      ok: false,
      message:
        error instanceof ChatGPTPlanError
          ? error.message
          : 'The ChatGPT sign-in could not be completed.',
    });
  }
}
