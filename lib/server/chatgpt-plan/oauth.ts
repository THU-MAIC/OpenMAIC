/**
 * The OAuth side of Sign in with ChatGPT: discovery, the authorization request
 * (PKCE, state and nonce), the code exchange with ID token verification,
 * refresh and revocation. Persistence and locking are `session.ts`'s.
 */
import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';

import { ChatGPTPlanError } from './errors';
import { authFetch } from './http';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
/** The resource plan usage tokens are issued for; also the inference base URL. */
export const CHATGPT_PLAN_API_BASE = 'https://api.openai.com/v1';
export const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  PLAN_USAGE_SCOPE,
];
/**
 * The client ID of a first sign-in. OpenAI registers a client for this
 * installation and returns its ID with the callback; later sign-ins use it.
 */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME = 'OpenMAIC';

/** Refresh errors after which only a new sign-in restores the connection. */
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Epoch ms before which the server asks not to refresh. */
  earliestRefreshAt?: number;
  scopes: string[];
}

export interface Identity {
  subject: string;
  email?: string;
}

/** The token endpoint refused a grant. */
export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly oauthError: string | undefined,
  ) {
    super(`ChatGPT token endpoint answered HTTP ${status}${oauthError ? ` (${oauthError})` : ''}`);
    this.name = 'TokenEndpointError';
  }

  /** Whether the refresh token can no longer be used. */
  get terminal(): boolean {
    return this.oauthError !== undefined && TERMINAL_REFRESH_ERRORS.has(this.oauthError);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ── Discovery ────────────────────────────────────────────────────────────────

interface Endpoints {
  authorization: string;
  token: string;
  jwks: string;
  revocation?: string;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
let discovery: { endpoints: Promise<Endpoints>; fetchedAt: number } | undefined;

async function discoverEndpoints(): Promise<Endpoints> {
  try {
    const response = await authFetch(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`discovery answered HTTP ${response.status}`);
    const document: unknown = await response.json();
    if (!isRecord(document) || document.issuer !== CHATGPT_ISSUER) {
      throw new Error('discovery names another issuer');
    }
    // Every endpoint must be on the issuer's origin.
    const endpoint = (key: string): string | undefined => {
      const value = document[key];
      if (value === undefined) return undefined;
      const url = typeof value === 'string' ? new URL(value) : undefined;
      if (url?.origin !== CHATGPT_ISSUER) throw new Error(`discovery ${key} is off the issuer`);
      return url.href;
    };
    const authorization = endpoint('authorization_endpoint');
    const token = endpoint('token_endpoint');
    const jwks = endpoint('jwks_uri');
    if (!authorization || !token || !jwks) throw new Error('discovery is missing an endpoint');
    const revocation = endpoint('revocation_endpoint');
    return { authorization, token, jwks, ...(revocation ? { revocation } : {}) };
  } catch (error) {
    throw new ChatGPTPlanError('upstream', { cause: error });
  }
}

/** The issuer's endpoints, cached for an hour; a failed lookup is not cached. */
function endpoints(): Promise<Endpoints> {
  if (!discovery || Date.now() - discovery.fetchedAt > DISCOVERY_TTL_MS) {
    const attempt = discoverEndpoints();
    discovery = { endpoints: attempt, fetchedAt: Date.now() };
    attempt.catch(() => {
      if (discovery?.endpoints === attempt) discovery = undefined;
    });
  }
  return discovery.endpoints;
}

export function resetDiscoveryForTests(): void {
  discovery = undefined;
  keySets.clear();
}

// ── Authorization request ────────────────────────────────────────────────────

const randomToken = () => randomBytes(32).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

export interface AuthorizationSecrets {
  state: string;
  nonce: string;
  verifier: string;
}

export function newAuthorizationSecrets(): AuthorizationSecrets {
  return { state: randomToken(), nonce: randomToken(), verifier: randomToken() };
}

/** How a pending sign-in is keyed: its `state` is never stored. */
export const hashState = sha256;

export interface AuthorizationRequest {
  clientId: string;
  /** The installation's agent host ID (`urn:uuid:…`). */
  hostId: string;
  redirectUri: string;
  secrets: AuthorizationSecrets;
  /** Show the consent screen again, to offer plan usage that was not allowed. */
  consent?: boolean;
  /** The account to sign in as, when signing in again. */
  loginHint?: string;
}

export async function authorizationUrl(request: AuthorizationRequest): Promise<string> {
  const url = new URL((await endpoints()).authorization);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: SCOPES.join(' '),
    state: request.secrets.state,
    nonce: request.secrets.nonce,
    code_challenge: sha256(request.secrets.verifier),
    code_challenge_method: 'S256',
    resource: CHATGPT_PLAN_API_BASE,
    ext_agent_host_id: request.hostId,
  };
  if (request.clientId === DYNAMIC_CLIENT_ID) params.agent_name_hint = AGENT_NAME;
  if (request.consent) params.prompt = 'consent';
  if (request.loginHint) params.login_hint = request.loginHint;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

// ── Token endpoint ───────────────────────────────────────────────────────────

async function tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
  const { token } = await endpoints();
  let response: Response;
  try {
    response = await authFetch(token, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new ChatGPTPlanError('upstream', { cause: error });
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = isRecord(body) ? body.error : undefined;
    const code = typeof error === 'string' ? error : isRecord(error) ? error.code : undefined;
    throw new TokenEndpointError(response.status, typeof code === 'string' ? code : undefined);
  }
  if (!isRecord(body)) throw new ChatGPTPlanError('upstream');
  return body;
}

function readTokenSet(body: Record<string, unknown>, previous?: TokenSet): TokenSet {
  const { access_token, refresh_token, expires_in, scope, earliest_refresh_at } = body;
  // A refresh may keep the refresh token or the scopes it does not repeat.
  const refreshToken =
    typeof refresh_token === 'string' && refresh_token ? refresh_token : previous?.refreshToken;
  if (
    typeof access_token !== 'string' ||
    !access_token ||
    !refreshToken ||
    typeof expires_in !== 'number' ||
    !(expires_in > 0)
  ) {
    throw new ChatGPTPlanError('upstream', {
      cause: new Error('the token response is incomplete'),
    });
  }
  const earliest =
    typeof earliest_refresh_at === 'number'
      ? earliest_refresh_at * 1000
      : typeof earliest_refresh_at === 'string'
        ? Date.parse(earliest_refresh_at)
        : Number.NaN;
  return {
    accessToken: access_token,
    refreshToken,
    expiresAt: Date.now() + expires_in * 1000,
    ...(Number.isFinite(earliest) ? { earliestRefreshAt: earliest } : {}),
    // An omitted scope is the one requested (or, on refresh, the one granted).
    scopes:
      typeof scope === 'string' ? scope.split(' ').filter(Boolean) : (previous?.scopes ?? SCOPES),
  };
}

export function allowsPlanUsage(tokens: TokenSet): boolean {
  return tokens.scopes.includes(PLAN_USAGE_SCOPE);
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<Identity> {
  const { jwks } = await endpoints();
  let keys = keySets.get(jwks);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwks), { [customFetch]: authFetch });
    keySets.set(jwks, keys);
  }
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: CHATGPT_ISSUER,
      audience: clientId,
      requiredClaims: ['exp', 'iat', 'sub'],
      clockTolerance: 60,
    }));
  } catch (error) {
    throw new ChatGPTPlanError('sign-in-failed', { cause: error });
  }
  if (payload.nonce !== nonce) {
    throw new ChatGPTPlanError('sign-in-failed', {
      cause: new Error('the ID token is for another sign-in'),
    });
  }
  return {
    subject: payload.sub!,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
  };
}

export interface CodeExchange {
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  nonce: string;
}

export async function exchangeCode(
  exchange: CodeExchange,
): Promise<{ tokens: TokenSet; identity: Identity }> {
  let body: Record<string, unknown>;
  try {
    body = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: exchange.clientId,
      code: exchange.code,
      code_verifier: exchange.verifier,
      redirect_uri: exchange.redirectUri,
      resource: CHATGPT_PLAN_API_BASE,
    });
  } catch (error) {
    if (error instanceof TokenEndpointError) {
      throw new ChatGPTPlanError('sign-in-failed', { cause: error });
    }
    throw error;
  }
  if (typeof body.id_token !== 'string') {
    throw new ChatGPTPlanError('sign-in-failed', { cause: new Error('no ID token') });
  }
  const identity = await verifyIdToken(body.id_token, exchange.clientId, exchange.nonce);
  return { tokens: readTokenSet(body), identity };
}

/**
 * Rotate the token set. Throws {@link TokenEndpointError} when the token
 * endpoint refuses (see its `terminal`), {@link ChatGPTPlanError} otherwise.
 * The account is the one signed in: a refresh does not change it.
 */
export async function refreshTokens(clientId: string, previous: TokenSet): Promise<TokenSet> {
  const body = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: previous.refreshToken,
    resource: CHATGPT_PLAN_API_BASE,
  });
  return readTokenSet(body, previous);
}

/**
 * Revoke a refresh token, retrying a server error twice. Answers whether
 * OpenAI confirmed the revocation.
 */
export async function revokeRefreshToken(clientId: string, refreshToken: string): Promise<boolean> {
  let revocation: string | undefined;
  try {
    revocation = (await endpoints()).revocation;
  } catch {
    return false;
  }
  if (!revocation) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    try {
      const response = await authFetch(revocation, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
          client_id: clientId,
        }).toString(),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // A transport failure is retried like a server error.
    }
  }
  return false;
}
