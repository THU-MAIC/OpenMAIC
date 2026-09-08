/**
 * Eduku SSO configuration (server + edge safe).
 *
 * Reads only `process.env` — no Node-only imports — so both the Edge
 * middleware and Node route handlers can share these accessors.
 *
 * SSO is considered configured when both `EDUKU_APP_ID` and
 * `EDUKU_APP_SECRET` are set. Everything else has a default that matches the
 * vendor contract from the integration notes:
 *
 *  - connect page:  https://www.eduku.cn/connect?appid=<appId>&redirect_uri=eduku.cn
 *    (posts `{ event: 'classai-login', data: CODE }` to the opener/parent)
 *  - token exchange: POST https://www.eduku.cn/api/v1/user/accesstoken
 *    (form body: code, appid — lowercase — signature=MD5(appId + code +
 *    appSecret), dataType=json; a GET or a body without dataType=json falls
 *    through to the SPA HTML page)
 */

const DEFAULT_EDUKU_ORIGIN = 'https://www.eduku.cn';

export function getEdukuAppId(): string | undefined {
  return process.env.EDUKU_APP_ID?.trim() || undefined;
}

export function getEdukuAppSecret(): string | undefined {
  return process.env.EDUKU_APP_SECRET?.trim() || undefined;
}

/** Origin allowed to post `classai-login` messages (checked on every message). */
export function getEdukuConnectOrigin(): string {
  const configured = process.env.EDUKU_CONNECT_ORIGIN?.trim();
  if (configured) return configured;
  const fromUrl = getEdukuConnectUrl();
  try {
    return new URL(fromUrl).origin;
  } catch {
    return DEFAULT_EDUKU_ORIGIN;
  }
}

/** Where `redirect_uri` in the connect link points after a successful login. */
export function getEdukuConnectRedirectUri(): string {
  return process.env.EDUKU_CONNECT_REDIRECT_URI?.trim() || 'eduku.cn';
}

/** The connect/login page the browser opens (iframe or popup). */
export function getEdukuConnectUrl(): string {
  const configured = process.env.EDUKU_CONNECT_URL?.trim();
  if (configured) return configured;
  const appId = getEdukuAppId() ?? '';
  const params = new URLSearchParams({ appid: appId });
  params.set('redirect_uri', getEdukuConnectRedirectUri());
  return `${DEFAULT_EDUKU_ORIGIN}/connect?${params.toString()}`;
}

/** The token-exchange endpoint (without query parameters). */
export function getEdukuAccessTokenUrl(): string {
  return (
    process.env.EDUKU_ACCESSTOKEN_URL?.trim() || `${DEFAULT_EDUKU_ORIGIN}/api/v1/user/accesstoken`
  );
}

/**
 * Secret used to HMAC-sign session cookies. Explicit `SESSION_SECRET` wins;
 * otherwise the Eduku app secret is reused so sessions survive restarts and
 * multi-instance deployments without extra configuration. Returns `undefined`
 * when neither is available (SSO disabled).
 */
export function getSessionSigningSecret(): string | undefined {
  const explicit = process.env.SESSION_SECRET?.trim();
  if (explicit) return explicit;
  const appSecret = getEdukuAppSecret();
  if (appSecret) return `eduku:${appSecret}`;
  return undefined;
}

/** Session lifetime in days (client cookie maxAge and DB expiry). */
export function getSessionTtlDays(): number {
  const parsed = Number(process.env.SESSION_TTL_DAYS);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 365) {
    return Math.floor(parsed);
  }
  return 7;
}

export function isSsoConfigured(): boolean {
  return Boolean(getEdukuAppId() && getEdukuAppSecret() && getSessionSigningSecret());
}

/**
 * Roles the vendor contract knows. `0` is the administrator (courseware
 * generation homepage), `3` teacher and `4` student are the courseware
 * viewers whose interactions are recorded.
 */
export const EDUKU_USER_ROLES = ['0', '3', '4'] as const;
export type EdukuUserRole = (typeof EDUKU_USER_ROLES)[number];

export function isEdukuUserRole(value: unknown): value is EdukuUserRole {
  return typeof value === 'string' && (EDUKU_USER_ROLES as readonly string[]).includes(value);
}

export function isAdminRole(role: unknown): boolean {
  return role === '0';
}
