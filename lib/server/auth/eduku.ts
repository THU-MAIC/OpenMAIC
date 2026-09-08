/**
 * Eduku SSO token exchange (Node-only).
 *
 * The browser never sees the app secret: it forwards the one-time `CODE`
 * received through the `classai-login` postMessage, and this module builds
 * the vendor signature `MD5(appId + code + appSecret)` before calling the
 * accesstoken endpoint.
 *
 * Vendor contract (reverse-verified against the live gateway):
 *
 *  - POST https://www.eduku.cn/api/v1/user/accesstoken
 *  - form body: `code`, `appid` (lowercase — the doc's `appId` is wrong),
 *    `signature`, and `dataType=json`. Without `dataType=json` the web host
 *    never reaches the API and answers with the SPA HTML page.
 *  - signature = lowercase hex MD5(appId + code + appSecret); a wrong
 *    signature answers `{"msg":"signature 非法",...}`, a spent code answers
 *    `{"msg":"令牌过期或非法",...}`.
 *  - the profile arrives as `{ success: true, data: { userid, uname,
 *    usertype, usertypename, name, avatar, institutionName, institutionId,
 *    updatephonetag, ... } }` — NOT the doc's edukuopenid/role shape. The
 *    account is keyed on `userid`; `usertype === '1'` (学校管理员) maps to
 *    the internal admin role, any other usertype to a courseware viewer.
 *
 * Diagnostics: every failure logs the HTTP status, Content-Type, and a capped
 * body excerpt (plus the request URL with the signature redacted), because the
 * vendor gateway answers with non-JSON pages for several classes of errors.
 * A short body snippet also rides the client-facing error so the operator
 * sees it in the browser without server log access.
 */

import { createHash } from 'crypto';

import { getEdukuAccessTokenUrl, getEdukuAppId, getEdukuAppSecret } from '@/lib/config/sso';
import { normalizeEdukuProfile, type EdukuUserProfile } from '@/lib/persistence/user-accounts';
import { createLogger } from '@/lib/logger';
import { proxyFetch } from '@/lib/server/proxy-fetch';

const log = createLogger('Eduku SSO');

export const EDUKU_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/** Upper bound of the response body kept in server logs. */
const MAX_LOG_BODY_LENGTH = 8_000;
/** Upper bound of the body snippet embedded in the client-facing error. */
const CLIENT_SNIPPET_LENGTH = 200;

/** MD5(appId + code + appSecret), lowercase hex — the vendor contract. */
export function edukuSignature(appId: string, code: string, appSecret: string): string {
  return createHash('md5').update(`${appId}${code}${appSecret}`).digest('hex');
}

export interface EdukuAccessTokenRequest {
  url: string;
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    cache: 'no-store';
  };
}

/** Build the accesstoken POST exactly the way the vendor gateway accepts it. */
export function buildEdukuAccessTokenRequest(
  code: string,
  appId: string,
  appSecret: string,
): EdukuAccessTokenRequest {
  const signature = edukuSignature(appId, code, appSecret);
  const params = new URLSearchParams({ code, appid: appId, signature, dataType: 'json' });
  return {
    url: getEdukuAccessTokenUrl(),
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        accept: 'application/json',
        'user-agent': 'OpenMAIC/1.0',
      },
      body: params.toString(),
      cache: 'no-store',
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function vendorMessage(payload: Record<string, unknown>): string {
  const msg = payload.msg ?? payload.cause ?? payload.message ?? payload.error;
  return typeof msg === 'string' && msg.trim() !== '' ? msg.trim() : 'unknown vendor error';
}

/**
 * Extract the user profile from a token-exchange payload. Accepts both
 * `{success, data: {...}}` and a bare profile object; a vendor refusal
 * (`success:false`, or an error body with `msg`) resolves to a failure detail.
 */
export function extractEdukuUserProfile(
  payload: unknown,
): { profile: EdukuUserProfile } | { failure: { detail: string } } {
  if (!isRecord(payload)) {
    return { failure: { detail: 'response is not an object' } };
  }
  if (payload.success === false || (payload.msg !== undefined && payload.data === undefined)) {
    return { failure: { detail: vendorMessage(payload) } };
  }
  const profileRaw = isRecord(payload.data) ? payload.data : payload;
  const profile = normalizeEdukuProfile(profileRaw);
  if (!profile) {
    return {
      failure: { detail: 'missing userid (vendor returned no stable user id)' },
    };
  }
  return { profile };
}

/** The exchange URL with the signature value masked for logs. */
function redactUrl(url: string): string {
  return url.replace(/([?&]signature=)[^&]*/i, '$1…');
}

function bodySnippet(body: string, maxLength: number): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}

export type EdukuExchangeFailure =
  | { kind: 'not-configured' }
  | { kind: 'upstream-http'; status: number; detail?: string }
  | { kind: 'upstream-json'; detail: string }
  | { kind: 'vendor-refusal'; detail: string };

export async function exchangeEdukuCode(
  code: string,
): Promise<{ profile: EdukuUserProfile } | { failure: EdukuExchangeFailure }> {
  const appId = getEdukuAppId();
  const appSecret = getEdukuAppSecret();
  if (!appId || !appSecret) return { failure: { kind: 'not-configured' } };

  const request = buildEdukuAccessTokenRequest(code, appId, appSecret);

  let response: Response;
  try {
    response = await proxyFetch(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(EDUKU_TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    log.error(`Eduku token exchange transport error [${redactUrl(request.url)}]:`, error);
    return { failure: { kind: 'upstream-http', status: 0 } };
  }

  const status = response.status;
  const contentType = response.headers.get('content-type') ?? '(none)';
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch {
    bodyText = '';
  }
  const loggedBody =
    bodyText.length > MAX_LOG_BODY_LENGTH
      ? `${bodyText.slice(0, MAX_LOG_BODY_LENGTH)}…(${bodyText.length - MAX_LOG_BODY_LENGTH} more chars)`
      : bodyText || '(empty body)';
  const snippet = bodySnippet(bodyText, CLIENT_SNIPPET_LENGTH);

  if (!response.ok) {
    log.error(
      `Eduku token exchange HTTP ${status} [content-type=${contentType}] ${redactUrl(request.url)} body: ${loggedBody}`,
    );
    return {
      failure: {
        kind: 'upstream-http',
        status,
        detail: snippet
          ? `HTTP ${status}, ${contentType} — ${snippet}`
          : `HTTP ${status}, ${contentType} — empty body`,
      },
    };
  }

  let payload: unknown;
  try {
    // Some gateways prefix the JSON with a UTF-8 BOM; JSON.parse rejects it.
    payload = JSON.parse(bodyText.replace(/^\uFEFF/, ''));
  } catch {
    log.error(
      `Eduku token exchange response is not JSON [HTTP ${status}, content-type=${contentType}] ${redactUrl(request.url)} body: ${loggedBody}`,
    );
    return {
      failure: {
        kind: 'upstream-json',
        detail: snippet
          ? `response is not JSON (HTTP ${status}, ${contentType}) — ${snippet}`
          : `response is not JSON (HTTP ${status}, ${contentType}) — empty body`,
      },
    };
  }

  const extracted = extractEdukuUserProfile(payload);
  if ('failure' in extracted) {
    log.warn(`Eduku token exchange refused: ${extracted.failure.detail} — body: ${loggedBody}`);
    return { failure: { kind: 'vendor-refusal', detail: extracted.failure.detail } };
  }
  return { profile: extracted.profile };
}
