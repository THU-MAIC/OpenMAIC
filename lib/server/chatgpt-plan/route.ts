/**
 * HTTP for the ChatGPT plan routes (`app/api/chatgpt-plan/*` and the loopback
 * callback at `app/auth/callback`).
 */
import 'server-only';

import { randomBytes } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { supportedLocaleOf, type Locale } from '@/lib/i18n/types';
import { LOCALE_COOKIE, resolveRequestLocale } from '@/lib/i18n/resolve-locale';
import { loadLocaleResource } from '@/lib/i18n/load-resource';
import type en from '@/lib/i18n/locales/en-US.json';
import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { apiError, type ApiErrorCode } from '@/lib/server/api-response';
import { capBodyStream } from '@/lib/server/capped-stream';
import { isPersonalInstallationOwner } from '@/lib/server/identity';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

import { ChatGPTPlanError, connectionErrorStatus } from './errors';

const log = createLogger('ChatGPT Plan');

function apiCode(error: ChatGPTPlanError): ApiErrorCode {
  if (error.code === 'unavailable') return 'PROVIDER_DISABLED';
  if (error.code === 'upstream' || error.code === 'sign-in-failed') return 'UPSTREAM_ERROR';
  return 'INVALID_REQUEST';
}

/**
 * Run a settings request: same-origin, for the owner of a personal
 * installation, never cached. A connection failure answers with its code as
 * `reason`, which the settings show in the user's language.
 */
export function chatGPTPlanRoute(
  request: Request,
  handle: () => Promise<Response>,
): Promise<Response> {
  return withRequestOwner(request, async (principal, headers) => {
    headers.set('cache-control', 'no-store');
    const respond = (response: Response) => {
      headers.forEach((value, key) => response.headers.set(key, value));
      return response;
    };
    const site = request.headers.get('sec-fetch-site');
    if (
      (site && site !== 'same-origin') ||
      (request.method !== 'GET' && !isSameOriginJsonRequest(request))
    ) {
      return respond(apiError('INVALID_REQUEST', 403, 'Cross-origin requests are refused.'));
    }
    if (!isPersonalInstallationOwner(principal)) {
      const error = new ChatGPTPlanError('unavailable');
      return respond(apiError(apiCode(error), 403, error.message, undefined, error.code));
    }
    try {
      return respond(await handle());
    } catch (error) {
      if (error instanceof ChatGPTPlanError) {
        if (error.code === 'upstream' || error.code === 'sign-in-failed') {
          log.warn('ChatGPT connection request failed:', error);
        }
        return respond(
          apiError(
            apiCode(error),
            connectionErrorStatus(error),
            error.message,
            undefined,
            error.code,
          ),
        );
      }
      log.error('ChatGPT plan route failed:', error);
      return respond(apiError('INTERNAL_ERROR', 500, 'The request could not be completed.'));
    }
  });
}

/** A small JSON object body. */
export async function chatGPTPlanBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  const capped = capBodyStream(request.body, 8192);
  let value: unknown;
  try {
    value = JSON.parse(await new Response(capped.stream).text());
  } catch {
    throw new ChatGPTPlanError('invalid-callback');
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

export function requestLocale(request: NextRequest): Locale {
  return resolveRequestLocale({
    cookie: request.cookies.get(LOCALE_COOKIE)?.value,
    acceptLanguage: request.headers.get('accept-language'),
  });
}

/**
 * The page the browser shows after a loopback sign-in. It takes the code and
 * state out of the address bar and the history, and sends no referrer.
 */
export async function callbackPage(
  request: NextRequest,
  result: ({ ok: true; returnTo?: string } | { ok: false; reason?: ChatGPTPlanError['code'] }) & {
    locale?: Locale;
  },
): Promise<Response> {
  const locale = supportedLocaleOf(result.locale) ?? requestLocale(request);
  const resource = (await loadLocaleResource(locale)) as typeof en;
  const copy = resource.settings.chatgptPlan;
  const nonce = randomBytes(16).toString('base64');
  const title = result.ok ? copy.callbackConnected : copy.callbackFailed;
  const message = result.ok
    ? copy.callbackComplete
    : result.reason === 'sign-in-expired'
      ? copy.errorExpired
      : result.reason === 'sign-in-denied'
        ? copy.errorDenied
        : result.reason === 'invalid-callback'
          ? copy.errorInvalidCallback
          : copy.errorFailed;
  const link =
    result.ok && result.returnTo
      ? `<p><a href="${escapeHtml(result.returnTo)}/">${escapeHtml(copy.callbackReturn)}</a></p>`
      : '';
  const html = `<!doctype html>
<html lang="${locale}" dir="${locale === 'ar-SA' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · OpenMAIC</title>
<style nonce="${nonce}">
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;color:#1f2328;background:#f6f7f9}
main{max-width:28rem;padding:2rem;margin:1rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0}a{color:#0969da}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}main{background:#161b22}a{color:#4493f8}}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
${link}
</main>
<script nonce="${nonce}">history.replaceState(null, '', location.pathname);${result.ok ? 'setTimeout(function(){window.close()},1500);' : ''}</script>
</body>
</html>`;
  return new Response(html, {
    status: result.ok ? 200 : 400,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}
