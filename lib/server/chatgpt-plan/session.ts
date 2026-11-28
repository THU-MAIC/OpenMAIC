/**
 * The installation's ChatGPT connection: signing in (loopback or pasted
 * callback), its status, the one-time notice, disconnecting, and the access
 * token inference uses.
 */
import 'server-only';

import { randomInt } from 'node:crypto';
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  CHATGPT_PLAN_CALLBACK_PATH,
  type ChatGPTPlanAttemptOutcome,
  type ChatGPTPlanSignInStart,
  type ChatGPTPlanStatus,
} from '@/lib/chatgpt-plan/shared';

import { chatGPTPlanAvailability } from './availability';
import { ChatGPTPlanError } from './errors';
import {
  allowsPlanUsage,
  authorizationUrl,
  CHATGPT_ISSUER,
  DYNAMIC_CLIENT_ID,
  exchangeCode,
  hashState,
  newAuthorizationSecrets,
  refreshTokens,
  revokeRefreshToken,
  TokenEndpointError,
} from './oauth';
import {
  chatGPTPlanDatabase,
  type Connection,
  type PendingSignIn,
  readConnection,
  saveClientId,
  saveDisconnected,
  saveNoticeAcknowledged,
  savePendingSignIn,
  saveReauthRequired,
  saveSignedIn,
  saveTokens,
  readPendingSignIn,
  attemptOutcome,
  finishAttempt,
  forgetRegistration,
} from './store';

const SIGN_IN_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60 * 1000;
/** A pasted callback names a port nothing listens on: any dynamic port will do. */
const PASTE_PORTS = { min: 49152, max: 65536 };
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function assertAvailable(): void {
  if (!chatGPTPlanAvailability().available) throw new ChatGPTPlanError('unavailable');
}

export async function chatGPTPlanStatus(): Promise<ChatGPTPlanStatus> {
  const availability = chatGPTPlanAvailability();
  if (!availability.available) {
    return {
      available: false,
      reason: availability.reason,
      state: 'disconnected',
      noticeAcknowledged: false,
    };
  }
  const { pool } = await chatGPTPlanDatabase();
  const connection = await readConnection(pool);
  return {
    available: true,
    state: connection.state,
    ...(connection.state === 'disconnected' && connection.clientId
      ? { canForgetRegistration: true as const }
      : {}),
    ...(connection.email ? { email: connection.email } : {}),
    noticeAcknowledged: connection.noticeAcknowledged,
  };
}

export async function acknowledgeChatGPTPlanNotice(): Promise<void> {
  assertAvailable();
  const { pool } = await chatGPTPlanDatabase();
  await readConnection(pool);
  await saveNoticeAcknowledged(pool);
}

/** The port a browser on this machine reaches the server on; undefined for another origin. */
function loopbackPort(browserOrigin: string | undefined): number | undefined {
  if (!browserOrigin) return undefined;
  let url: URL;
  try {
    url = new URL(browserOrigin);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  return url.port ? Number(url.port) : 80;
}

/**
 * Start a sign-in. A browser on this machine (an `http://` loopback origin)
 * returns to this server's own callback; any other browser lands on a
 * loopback address nothing answers, whose URL the user pastes back.
 */
export async function beginChatGPTSignIn(
  browserOrigin: string | undefined,
  locale?: PendingSignIn['locale'],
): Promise<ChatGPTPlanSignInStart> {
  assertAvailable();
  const { withTransaction } = await chatGPTPlanDatabase();
  return withTransaction(async (q) => {
    await lockTokens(q);
    const connection = await readConnection(q);
    const port = loopbackPort(browserOrigin);
    const redirectUri = `http://127.0.0.1:${port ?? randomInt(PASTE_PORTS.min, PASTE_PORTS.max)}${CHATGPT_PLAN_CALLBACK_PATH}`;
    const secrets = newAuthorizationSecrets();
    const clientId = connection.clientId ?? DYNAMIC_CLIENT_ID;
    const url = await authorizationUrl({
      clientId,
      hostId: connection.hostId,
      redirectUri,
      secrets,
      consent: connection.state === 'sharing-disabled',
      ...(connection.state === 'reauth-required' && connection.email
        ? { loginHint: connection.email }
        : {}),
    });
    const expiresAt = Date.now() + SIGN_IN_TTL_MS;
    const attemptId = hashState(secrets.state);
    await savePendingSignIn(
      q,
      attemptId,
      {
        ...(locale && { locale }),
        verifier: secrets.verifier,
        nonce: secrets.nonce,
        redirectUri,
        clientId,
        ...(port !== undefined && browserOrigin ? { returnTo: new URL(browserOrigin).origin } : {}),
      },
      new Date(expiresAt),
    );
    return {
      attemptId,
      authorizationUrl: url,
      flow: port === undefined ? 'paste' : 'loopback',
      expiresAt,
    };
  });
}

/**
 * The callback, as this server's loopback route received it (`params`), or
 * as the address the user pasted (`address`), which must be the redirect
 * the sign-in named.
 */
export type ChatGPTPlanCallback =
  | { params: URLSearchParams }
  | { address: string; attemptId?: string };

export async function completeChatGPTSignIn(
  callback: ChatGPTPlanCallback,
): Promise<Pick<PendingSignIn, 'returnTo' | 'locale'> & { sharingDisabled?: true }> {
  assertAvailable();
  let params: URLSearchParams;
  let pasted: URL | undefined;
  if ('params' in callback) {
    params = callback.params;
  } else {
    try {
      pasted = new URL(callback.address.trim());
    } catch {
      throw new ChatGPTPlanError('invalid-callback');
    }
    params = pasted.searchParams;
  }
  const state = params.get('state');
  if (!state) throw new ChatGPTPlanError('invalid-callback');
  const attemptId = hashState(state);
  if ('address' in callback && callback.attemptId && callback.attemptId !== attemptId) {
    throw new ChatGPTPlanError('invalid-callback');
  }

  const { pool, withTransaction } = await chatGPTPlanDatabase();
  // Completed, expired and unknown callbacks need no token lock. Recheck under
  // the lock because another callback or a cancellation may finish first.
  if ((await attemptOutcome(pool, attemptId)) !== 'pending') {
    throw new ChatGPTPlanError('sign-in-expired');
  }
  const outcome = await withTransaction(async (q) => {
    await lockTokens(q);
    const pending = await readPendingSignIn(q, attemptId);
    if (!pending) throw new ChatGPTPlanError('sign-in-expired');
    try {
      const state = await finishSignIn(q, pending, params, pasted);
      await finishAttempt(q, attemptId, state);
      return {
        ...(pending.returnTo && { returnTo: pending.returnTo }),
        ...(pending.locale && { locale: pending.locale }),
        ...(state === 'sharing-disabled' && { sharingDisabled: true as const }),
      };
    } catch (error) {
      // Consume each attempt even on denial or failure. Keep its issued client
      // ID so an unsuccessful first exchange can be retried with a fresh code.
      if (error instanceof ChatGPTPlanError) {
        const reason =
          error.code === 'sign-in-denied' ||
          error.code === 'account-mismatch' ||
          error.code === 'invalid-callback' ||
          error.code === 'sign-in-expired'
            ? error.code
            : 'sign-in-failed';
        await finishAttempt(q, attemptId, reason);
        error.locale = pending.locale;
        return error;
      }
      throw error;
    }
  });
  if (outcome instanceof ChatGPTPlanError) throw outcome;
  return outcome;
}

async function finishSignIn(
  q: Queryable,
  pending: PendingSignIn,
  params: URLSearchParams,
  pasted?: URL,
): Promise<'connected' | 'sharing-disabled'> {
  if (pasted && `${pasted.origin}${pasted.pathname}` !== pending.redirectUri) {
    throw new ChatGPTPlanError('invalid-callback');
  }
  const error = params.get('error');
  if (error) {
    throw new ChatGPTPlanError(error === 'access_denied' ? 'sign-in-denied' : 'sign-in-failed');
  }
  const issuer = params.get('iss');
  const code = params.get('code');
  if ((issuer !== null && issuer !== CHATGPT_ISSUER) || !code) {
    throw new ChatGPTPlanError('sign-in-failed');
  }

  // A first sign-in returns the client OpenAI registered for this
  // installation; a later one may repeat its ID, never name another.
  const returned = params.get('client_id') ?? undefined;
  const clientId = pending.clientId === DYNAMIC_CLIENT_ID ? returned : pending.clientId;
  if (!clientId || clientId === DYNAMIC_CLIENT_ID || (returned && returned !== clientId)) {
    throw new ChatGPTPlanError('sign-in-failed');
  }
  const connection = await readConnection(q, { forUpdate: true });
  if (connection.clientId && connection.clientId !== clientId) {
    throw new ChatGPTPlanError('sign-in-expired');
  }
  if (!connection.clientId) await saveClientId(q, clientId);

  const { tokens, identity } = await exchangeCode({
    clientId,
    code,
    verifier: pending.verifier,
    redirectUri: pending.redirectUri,
    nonce: pending.nonce,
  });
  if (connection.subject && identity.subject !== connection.subject) {
    // End the unused session without revoking a credential we still hold.
    if (tokens.refreshToken !== connection.tokens?.refreshToken) {
      await revokeRefreshToken(clientId, tokens.refreshToken);
    }
    throw new ChatGPTPlanError('account-mismatch');
  }
  const state = allowsPlanUsage(tokens) ? 'connected' : 'sharing-disabled';
  await saveSignedIn(q, { identity, tokens, state });
  return state;
}

/** Every token rotation, and disconnecting, holds this lock across processes. */
async function lockTokens(q: Queryable): Promise<void> {
  await q.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('openmaic.chatgpt-plan.tokens', 0))",
  );
}

/**
 * Disconnect: revoke the refresh token and forget the account. The local
 * credential is removed even when OpenAI does not confirm the revocation;
 * `revoked: false` asks the user to disconnect the app in ChatGPT.
 */
export async function disconnectChatGPT(): Promise<{ revoked: boolean }> {
  const { withTransaction } = await chatGPTPlanDatabase();
  return withTransaction(async (q) => {
    await lockTokens(q);
    const connection = await readConnection(q, { forUpdate: true });
    const revoked =
      connection.tokens && connection.clientId
        ? await revokeRefreshToken(connection.clientId, connection.tokens.refreshToken)
        : connection.state === 'disconnected';
    await saveDisconnected(q);
    return { revoked };
  });
}

export async function forgetChatGPTRegistration(): Promise<void> {
  assertAvailable();
  const { withTransaction } = await chatGPTPlanDatabase();
  await withTransaction(async (q) => {
    await lockTokens(q);
    const connection = await readConnection(q);
    if (connection.state !== 'disconnected') throw new ChatGPTPlanError('disconnect-first');
    await forgetRegistration(q);
  });
}

export async function chatGPTSignInAttempt(
  id: string,
  cancel = false,
): Promise<ChatGPTPlanAttemptOutcome> {
  assertAvailable();
  const { pool, withTransaction } = await chatGPTPlanDatabase();
  if (!cancel) return attemptOutcome(pool, id);
  return withTransaction(async (q) => {
    await lockTokens(q);
    await finishAttempt(q, id, 'sign-in-denied');
    return attemptOutcome(q, id);
  });
}

function usableToken(connection: Connection, rejected: string | undefined): string | undefined {
  if (connection.state === 'disconnected') throw new ChatGPTPlanError('not-connected');
  if (connection.state !== 'connected') throw new ChatGPTPlanError(connection.state);
  const tokens = connection.tokens!;
  return tokens.accessToken !== rejected && tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()
    ? tokens.accessToken
    : undefined;
}

/**
 * An access token for plan usage. Pass `rejected` when the API refused a
 * token, to refresh it before it expires.
 *
 * Refreshing takes a lock every process shares and reads the connection
 * again under it, so one rotation happens at a time and everyone uses its
 * result. It takes no abort signal: a rotation the server completed is always
 * saved, or the next refresh would present a spent token.
 */
export async function chatGPTPlanAccessToken(rejected?: string): Promise<string> {
  assertAvailable();
  const { pool, withTransaction } = await chatGPTPlanDatabase();
  const ready = usableToken(await readConnection(pool), rejected);
  if (ready) return ready;

  // A failure that changes the stored state is thrown after its commit.
  const outcome = await withTransaction(
    async (q): Promise<{ token: string } | { failure: ChatGPTPlanError }> => {
      await lockTokens(q);
      const connection = await readConnection(q, { forUpdate: true });
      const rotated = usableToken(connection, rejected);
      if (rotated) return { token: rotated };
      const tokens = connection.tokens!;
      // Too early to refresh: the current token is the one to use.
      if ((tokens.earliestRefreshAt ?? 0) > Date.now() && tokens.expiresAt > Date.now()) {
        return { token: tokens.accessToken };
      }
      let next;
      try {
        next = await refreshTokens(connection.clientId!, tokens);
      } catch (error) {
        if (error instanceof TokenEndpointError && error.terminal) {
          await saveReauthRequired(q);
          return { failure: new ChatGPTPlanError('reauth-required', { cause: error }) };
        }
        throw error instanceof ChatGPTPlanError
          ? error
          : new ChatGPTPlanError('upstream', { cause: error });
      }
      if (!allowsPlanUsage(next)) {
        await saveTokens(q, next, 'sharing-disabled');
        return { failure: new ChatGPTPlanError('sharing-disabled') };
      }
      await saveTokens(q, next, 'connected');
      return { token: next.accessToken };
    },
  );
  if ('failure' in outcome) throw outcome.failure;
  return outcome.token;
}
