/**
 * Signing in with ChatGPT, against a scripted OpenAI auth server and an
 * isolated schema on local PG: the loopback and pasted callbacks, the client
 * registration, token rotation under the lock, and disconnecting.
 */
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Locale } from '@/lib/i18n/types';
import { Pool } from 'pg';
import { nodePostgresTransaction } from '@openmaic/storage/server/reference';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

let pool: Pool;
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({
    pool,
    withTransaction: nodePostgresTransaction(pool),
  }),
}));
vi.mock('@/lib/server/chatgpt-plan/availability', () => ({
  chatGPTPlanAvailability: () => ({ available: true }),
}));

const ISSUER = 'https://auth.openai.com';
const keys = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

/** The scripted auth server: what each sign-in asked for, and how token requests answer. */
const server = {
  authorizations: [] as URLSearchParams[],
  tokenRequests: [] as URLSearchParams[],
  revocations: [] as URLSearchParams[],
  scope: undefined as string | undefined,
  subject: 'user-1',
  refreshError: undefined as string | undefined,
  issued: 0,
};

async function idToken(audience: string, nonce: string) {
  return new SignJWT({ nonce, email: 'learner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(server.subject)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

vi.mock('@/lib/server/chatgpt-plan/http', () => ({
  inferenceFetch: vi.fn(),
  authFetch: async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${ISSUER}/oauth/revoke`,
      });
    }
    if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
    const form = new URLSearchParams(String(init?.body));
    if (url.pathname === '/oauth/revoke') {
      server.revocations.push(form);
      return new Response(null, { status: 200 });
    }
    server.tokenRequests.push(form);
    if (form.get('grant_type') === 'refresh_token') {
      if (server.refreshError)
        return Response.json({ error: server.refreshError }, { status: 400 });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } else {
      // The code is only good with the verifier of its challenge.
      const challenge = createHash('sha256').update(form.get('code_verifier')!).digest('base64url');
      if (!server.authorizations.some((request) => request.get('code_challenge') === challenge)) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
    }
    server.issued += 1;
    return Response.json({
      access_token: `access-${server.issued}`,
      refresh_token: `refresh-${server.issued}`,
      expires_in: 3600,
      scope: server.scope,
      ...(form.get('grant_type') === 'authorization_code'
        ? {
            id_token: await idToken(
              form.get('client_id')!,
              server.authorizations
                .find(
                  (request) =>
                    request.get('code_challenge') ===
                    createHash('sha256').update(form.get('code_verifier')!).digest('base64url'),
                )!
                .get('nonce')!,
            ),
          }
        : {}),
    });
  },
}));

import { resetDiscoveryForTests } from '@/lib/server/chatgpt-plan/oauth';
import {
  acknowledgeChatGPTPlanNotice,
  beginChatGPTSignIn,
  chatGPTPlanAccessToken,
  chatGPTPlanStatus,
  completeChatGPTSignIn,
  disconnectChatGPT,
} from '@/lib/server/chatgpt-plan/session';

const schema = 'chatgpt_plan_' + randomUUID().replaceAll('-', '');

/** Start a sign-in and record what the authorization request carried. */
async function begin(origin: string, locale?: Locale) {
  const start = await beginChatGPTSignIn(origin, locale);
  const params = new URL(start.authorizationUrl).searchParams;
  server.authorizations.push(params);
  return { start, params };
}

async function initialSignIn() {
  const { params } = await begin('http://localhost:3000');
  await completeChatGPTSignIn({
    params: new URLSearchParams({
      code: 'initial-code',
      state: params.get('state')!,
      client_id: 'client-issued',
    }),
  });
}

describe.skipIf(!process.env.PG_CONTRACT_URL)('ChatGPT sign-in and token rotation', () => {
  beforeAll(async () => {
    const admin = new Pool({ connectionString: process.env.PG_CONTRACT_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({
      connectionString: process.env.PG_CONTRACT_URL,
      options: `-c search_path=${schema}`,
    });
    vi.stubEnv('DATABASE_URL', 'fixture');
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'pg-test-secret-only');
    resetDiscoveryForTests();
    await chatGPTPlanStatus();
  });
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE chatgpt_plan_sign_ins, chatgpt_plan_connection');
    server.authorizations.length = 0;
    server.tokenRequests.length = 0;
    server.revocations.length = 0;
    server.issued = 0;
    server.subject = 'user-1';
    server.scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
    server.refreshError = undefined;
  });

  it('signs in on this machine, registering a client for the installation', async () => {
    const { start, params } = await begin('http://localhost:3000', 'zh-TW');
    expect(start.flow).toBe('loopback');
    expect(Object.fromEntries(params)).toMatchObject({
      response_type: 'code',
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'OpenMAIC',
      redirect_uri: 'http://127.0.0.1:3000/auth/callback',
      resource: 'https://api.openai.com/v1',
      code_challenge_method: 'S256',
    });
    expect(params.get('scope')!.split(' ')).toContain('chatgpt.tokens.use.direct');
    expect(params.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);

    const callback = new URLSearchParams({
      code: 'code-1',
      state: params.get('state')!,
      client_id: 'client-issued',
    });
    expect(await completeChatGPTSignIn({ params: callback })).toEqual({
      returnTo: 'http://localhost:3000',
      locale: 'zh-TW',
    });
    expect(server.tokenRequests[0]!.get('client_id')).toBe('client-issued');
    expect(await chatGPTPlanStatus()).toEqual({
      available: true,
      state: 'connected',
      email: 'learner@example.com',
      noticeAcknowledged: false,
    });
    // A callback completes once.
    await expect(completeChatGPTSignIn({ params: callback })).rejects.toMatchObject({
      code: 'sign-in-expired',
    });
    // The token set is stored sealed.
    const { rows } = await pool.query('SELECT credential FROM chatgpt_plan_connection');
    expect(JSON.stringify(rows[0])).not.toContain('access-1');
    expect(await chatGPTPlanAccessToken()).toBe('access-1');
  });

  it('rotates a refused token once for every caller', async () => {
    await initialSignIn();
    server.tokenRequests.length = 0;
    const [first, second] = await Promise.all([
      chatGPTPlanAccessToken('access-1'),
      chatGPTPlanAccessToken('access-1'),
    ]);
    expect(first).toBe(second);
    expect(server.tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(server.tokenRequests[0]!)).toMatchObject({
      grant_type: 'refresh_token',
      client_id: 'client-issued',
      refresh_token: 'refresh-1',
      resource: 'https://api.openai.com/v1',
    });
    expect(await chatGPTPlanAccessToken()).toBe(first);
  });

  it('signs in from another machine with the pasted address, reusing the registration', async () => {
    await initialSignIn();
    const { start, params } = await begin('https://maic.example.com', 'de-DE');
    expect(start.flow).toBe('paste');
    expect(params.get('client_id')).toBe('client-issued');
    expect(params.has('agent_name_hint')).toBe(false);
    const redirect = new URL(params.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThanOrEqual(49152);

    const query = `?code=code-2&state=${params.get('state')}`;
    await expect(
      completeChatGPTSignIn({ address: `http://127.0.0.1:1/auth/callback${query}` }),
    ).rejects.toMatchObject({ code: 'invalid-callback', locale: 'de-DE' });

    const retry = await begin('https://maic.example.com');
    const address = `${retry.params.get('redirect_uri')}?code=code-3&state=${retry.params.get('state')}`;
    expect(await completeChatGPTSignIn({ address: `  ${address}\n` })).toEqual({});
    expect((await chatGPTPlanStatus()).state).toBe('connected');
  });

  it('asks to sign in again when the refresh token is spent', async () => {
    await initialSignIn();
    server.refreshError = 'refresh_token_reused';
    const current = await chatGPTPlanAccessToken();
    await expect(chatGPTPlanAccessToken(current)).rejects.toMatchObject({
      code: 'reauth-required',
    });
    const status = await chatGPTPlanStatus();
    expect(status).toMatchObject({ state: 'reauth-required', email: 'learner@example.com' });
    const { params } = await begin('http://localhost:3000');
    expect(params.get('login_hint')).toBe('learner@example.com');
  });

  it('keeps a sign-in that did not allow plan usage apart, and offers consent again', async () => {
    await initialSignIn();
    server.scope = 'openid profile email offline_access';
    const { params } = await begin('http://localhost:3000');
    await completeChatGPTSignIn({
      params: new URLSearchParams({ code: 'code-4', state: params.get('state')! }),
    });
    expect((await chatGPTPlanStatus()).state).toBe('sharing-disabled');
    await expect(chatGPTPlanAccessToken()).rejects.toMatchObject({ code: 'sharing-disabled' });
    const again = await begin('http://localhost:3000');
    expect(again.params.get('prompt')).toBe('consent');
    server.scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  });

  it('disconnects: revokes the refresh token and keeps the registration', async () => {
    await initialSignIn();
    const { params } = await begin('http://localhost:3000');
    await completeChatGPTSignIn({
      params: new URLSearchParams({ code: 'code-5', state: params.get('state')! }),
    });
    expect(await disconnectChatGPT()).toEqual({ revoked: true });
    expect(Object.fromEntries(server.revocations.at(-1)!)).toMatchObject({
      token_type_hint: 'refresh_token',
      client_id: 'client-issued',
    });
    expect(await chatGPTPlanStatus()).toMatchObject({ state: 'disconnected' });
    await expect(chatGPTPlanAccessToken()).rejects.toMatchObject({ code: 'not-connected' });
    const next = await begin('http://localhost:3000');
    expect(next.params.get('client_id')).toBe('client-issued');
  });

  it('requires a granted plan scope in the first token response', async () => {
    server.scope = undefined;
    await initialSignIn();
    expect((await chatGPTPlanStatus()).state).toBe('sharing-disabled');
    await expect(chatGPTPlanAccessToken()).rejects.toMatchObject({ code: 'sharing-disabled' });
  });

  it('remembers dismissal of the welcome on a later successful connection', async () => {
    await initialSignIn();
    await acknowledgeChatGPTPlanNotice();
    await disconnectChatGPT();
    await initialSignIn();
    expect(await chatGPTPlanStatus()).toMatchObject({
      state: 'connected',
      noticeAcknowledged: true,
    });
  });

  it('preserves the registered account across disconnect and checks it on reconnect', async () => {
    await initialSignIn();
    await disconnectChatGPT();
    const { params } = await begin('http://localhost:3000');
    server.subject = 'different-account';
    await expect(
      completeChatGPTSignIn({
        params: new URLSearchParams({ code: 'returning-code', state: params.get('state')! }),
      }),
    ).rejects.toMatchObject({ code: 'sign-in-failed' });
    expect((await chatGPTPlanStatus()).state).toBe('disconnected');
  });

  it('cancels a pending sign-in when the user disconnects', async () => {
    await initialSignIn();
    const { params } = await begin('http://localhost:3000');
    await disconnectChatGPT();
    await expect(
      completeChatGPTSignIn({
        params: new URLSearchParams({ code: 'older-code', state: params.get('state')! }),
      }),
    ).rejects.toMatchObject({ code: 'sign-in-expired' });
  });
});
