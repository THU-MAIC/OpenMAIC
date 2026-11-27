/**
 * Rows of the ChatGPT plan tables (`lib/persistence/chatgpt-plan.ts`). The
 * token set and each pending sign-in are sealed with the instance secret.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';
import type { Queryable } from '@openmaic/storage/document/pg';

import type { ChatGPTPlanConnectionState } from '@/lib/chatgpt-plan/shared';
import { provisionChatGPTPlanSchema } from '@/lib/persistence/chatgpt-plan';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import {
  isSealedSecret,
  openSecret,
  SecretCorruptError,
  SecretKeyMismatchError,
  sealSecret,
} from '@/lib/server/secret-box';

import { ChatGPTPlanError } from './errors';
import type { Identity, TokenSet } from './oauth';

const CREDENTIAL_CONTEXT = 'chatgpt-plan:credential:v1';
const signInContext = (stateHash: string) => `chatgpt-plan:sign-in:v1:${stateHash}`;

export async function chatGPTPlanDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new ChatGPTPlanError('unavailable', { cause: new Error('DATABASE_URL is not set') });
  }
  const provider = await getServerPersistenceProvider(url);
  await provisionChatGPTPlanSchema(provider.pool);
  return provider;
}

export interface Connection {
  /** The installation's agent host ID, kept across sign-ins. */
  hostId: string;
  /** The client OpenAI registered for this installation, kept across sign-ins. */
  clientId?: string;
  email?: string;
  state: ChatGPTPlanConnectionState;
  tokens?: TokenSet;
  noticeAcknowledged: boolean;
}

interface ConnectionRow {
  host_id: string;
  client_id: string | null;
  email: string | null;
  state: ChatGPTPlanConnectionState;
  credential: unknown;
  notice_acknowledged_at: Date | null;
}

/** A sealed value that no longer opens (the instance secret changed) reads as absent. */
function openSealed(value: unknown, context: string): string | undefined {
  if (!isSealedSecret(value)) return undefined;
  try {
    return openSecret(value, context);
  } catch (error) {
    if (error instanceof SecretKeyMismatchError || error instanceof SecretCorruptError) {
      return undefined;
    }
    throw error;
  }
}

const seal = (plaintext: string, context: string) => JSON.stringify(sealSecret(plaintext, context));

/**
 * The connection row, created with a new host ID on first use. `forUpdate`
 * locks it for the caller's transaction.
 */
export async function readConnection(
  q: Queryable,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<Connection> {
  const select = () =>
    q.query<ConnectionRow & Record<string, unknown>>(
      `SELECT host_id, client_id, email, state, credential, notice_acknowledged_at
         FROM chatgpt_plan_connection WHERE id = 1${forUpdate ? ' FOR UPDATE' : ''}`,
    );
  let row = (await select()).rows[0];
  if (!row) {
    await q.query(
      'INSERT INTO chatgpt_plan_connection (id, host_id) VALUES (1, $1) ON CONFLICT (id) DO NOTHING',
      [`urn:uuid:${randomUUID()}`],
    );
    row = (await select()).rows[0]!;
  }
  const credential = openSealed(row.credential, CREDENTIAL_CONTEXT);
  const tokens = credential === undefined ? undefined : (JSON.parse(credential) as TokenSet);
  const needsTokens = row.state === 'connected' || row.state === 'sharing-disabled';
  return {
    hostId: row.host_id,
    ...(row.client_id ? { clientId: row.client_id } : {}),
    ...(row.email ? { email: row.email } : {}),
    // Tokens that no longer open leave a connection that has to sign in again.
    state: needsTokens && !tokens ? 'reauth-required' : row.state,
    ...(tokens ? { tokens } : {}),
    noticeAcknowledged: row.notice_acknowledged_at !== null,
  };
}

/** Kept before the code exchange, so a failed exchange still reuses the registration. */
export async function saveClientId(q: Queryable, clientId: string): Promise<void> {
  await q.query(
    'UPDATE chatgpt_plan_connection SET client_id = $1, updated_at = now() WHERE id = 1',
    [clientId],
  );
}

export async function saveSignedIn(
  q: Queryable,
  signedIn: { identity: Identity; tokens: TokenSet; state: 'connected' | 'sharing-disabled' },
): Promise<void> {
  await q.query(
    `UPDATE chatgpt_plan_connection
        SET subject = $1, email = $2, state = $3, credential = $4::jsonb, updated_at = now()
      WHERE id = 1`,
    [
      signedIn.identity.subject,
      signedIn.identity.email ?? null,
      signedIn.state,
      seal(JSON.stringify(signedIn.tokens), CREDENTIAL_CONTEXT),
    ],
  );
}

export async function saveTokens(
  q: Queryable,
  tokens: TokenSet,
  state: 'connected' | 'sharing-disabled',
): Promise<void> {
  await q.query(
    `UPDATE chatgpt_plan_connection SET state = $1, credential = $2::jsonb, updated_at = now()
      WHERE id = 1`,
    [state, seal(JSON.stringify(tokens), CREDENTIAL_CONTEXT)],
  );
}

/** The refresh token is dead: drop it, keep the email to sign in as again. */
export async function saveReauthRequired(q: Queryable): Promise<void> {
  await q.query(
    `UPDATE chatgpt_plan_connection SET state = 'reauth-required', credential = NULL,
            updated_at = now() WHERE id = 1`,
  );
}

/** Forget the account; the host ID and client registration stay for the next sign-in. */
export async function saveDisconnected(q: Queryable): Promise<void> {
  await q.query(
    `UPDATE chatgpt_plan_connection SET state = 'disconnected', credential = NULL, subject = NULL,
            email = NULL, updated_at = now() WHERE id = 1`,
  );
}

export async function saveNoticeAcknowledged(q: Queryable): Promise<void> {
  await q.query(
    `UPDATE chatgpt_plan_connection
        SET notice_acknowledged_at = COALESCE(notice_acknowledged_at, now()), updated_at = now()
      WHERE id = 1`,
  );
}

export interface PendingSignIn {
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** The client ID the authorization request named. */
  clientId: string;
  /** The browser origin a loopback callback returns to. */
  returnTo?: string;
}

export async function savePendingSignIn(
  q: Queryable,
  stateHash: string,
  pending: PendingSignIn,
  expiresAt: Date,
): Promise<void> {
  await q.query('DELETE FROM chatgpt_plan_sign_ins WHERE expires_at < now()');
  await q.query(
    'INSERT INTO chatgpt_plan_sign_ins (state_hash, pending, expires_at) VALUES ($1, $2::jsonb, $3)',
    [stateHash, seal(JSON.stringify(pending), signInContext(stateHash)), expiresAt],
  );
}

/** Take a pending sign-in: each one completes at most once. */
export async function takePendingSignIn(
  q: Queryable,
  stateHash: string,
): Promise<PendingSignIn | undefined> {
  const { rows } = await q.query<{ pending: unknown }>(
    'DELETE FROM chatgpt_plan_sign_ins WHERE state_hash = $1 AND expires_at > now() RETURNING pending',
    [stateHash],
  );
  const opened = openSealed(rows[0]?.pending, signInContext(stateHash));
  return opened === undefined ? undefined : (JSON.parse(opened) as PendingSignIn);
}
