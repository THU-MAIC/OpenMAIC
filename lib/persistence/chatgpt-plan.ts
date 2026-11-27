/**
 * Tables of the ChatGPT plan provider (preview; `lib/server/chatgpt-plan`).
 *
 * `chatgpt_plan_connection` holds one row: a personal installation connects
 * one ChatGPT account. It keeps the installation's agent host ID and the client
 * OpenAI registered for it across sign-ins and disconnects, so a later sign-in
 * reuses both; the token set is sealed with the instance secret and cleared on
 * disconnect. `chatgpt_plan_sign_ins` holds the sign-ins in flight, keyed by a
 * hash of their OAuth `state`, each with its sealed PKCE verifier and nonce.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';

export const CHATGPT_PLAN_MIGRATIONS: SchemaMigrationSet = {
  store: 'chatgpt-plan',
  migrations: [
    {
      version: 1,
      name: 'baseline',
      transaction: true,
      up: `
CREATE TABLE IF NOT EXISTS chatgpt_plan_connection (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  host_id TEXT NOT NULL,
  client_id TEXT,
  subject TEXT,
  email TEXT,
  state TEXT NOT NULL DEFAULT 'disconnected' CHECK (state IN
    ('disconnected','connected','sharing-disabled','reauth-required')),
  credential JSONB,
  notice_acknowledged_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (state <> 'disconnected' OR credential IS NULL),
  CHECK (state NOT IN ('connected','sharing-disabled') OR credential IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS chatgpt_plan_sign_ins (
  state_hash TEXT PRIMARY KEY,
  pending JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);`,
    },
    {
      version: 2,
      name: 'sign-in-outcomes',
      transaction: true,
      up: `ALTER TABLE chatgpt_plan_sign_ins ADD COLUMN outcome TEXT,
           ALTER COLUMN pending DROP NOT NULL;`,
    },
  ],
};

export async function ensureChatGPTPlanSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, CHATGPT_PLAN_MIGRATIONS);
}

const SCHEMA_STATE_KEY = Symbol.for('openmaic.chatgpt-plan.schema');
const globalState = globalThis as typeof globalThis & {
  [SCHEMA_STATE_KEY]?: WeakMap<ConnectableQueryable, Promise<void>>;
};
const provisioned = (globalState[SCHEMA_STATE_KEY] ??= new WeakMap());

/**
 * Provision the tables at most once per process and pool, under the bootstrap
 * lock. A failed attempt is cleared so a later call retries.
 */
export function provisionChatGPTPlanSchema(pool: ConnectableQueryable): Promise<void> {
  const existing = provisioned.get(pool);
  if (existing) return existing;
  const attempt = withSchemaBootstrapLock(pool, ensureChatGPTPlanSchema).catch((error) => {
    provisioned.delete(pool);
    throw error;
  });
  provisioned.set(pool, attempt);
  return attempt;
}
