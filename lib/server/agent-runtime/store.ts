import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
  type WithTransaction,
} from '@openmaic/storage/agent-session/pg';
import { extractObservedUrls } from '@openmaic/storage';
import type { Pool } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { notifyDurableAgentEvent } from './event-notify-bus';

interface AgentSessionStoreState {
  connectionString?: string;
  storePromise?: Promise<PgAgentSessionStore>;
}

const AGENT_SESSION_STORE_STATE_KEY = Symbol.for('openmaic.agent-session.store');
const globalState = globalThis as typeof globalThis & {
  [AGENT_SESSION_STORE_STATE_KEY]?: AgentSessionStoreState;
};
const storeState = (globalState[AGENT_SESSION_STORE_STATE_KEY] ??= {});

/**
 * Adapt a node-postgres pool to the storage package's transaction contract.
 * Every transaction uses one checked-out client for its entire lifetime.
 */
export function nodePostgresTransaction(pool: Pool): WithTransaction {
  return async <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function createAgentSessionStore(connectionString: string): Promise<PgAgentSessionStore> {
  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureAgentSessionSchema(pool);
  // URL observations from user-authored prompt/message text are registered
  // inside the same business transaction that creates the session / posts the
  // message (reference session-store semantics), so they commit atomically and
  // a registration failure aborts the write. The hooks run only after the
  // store is constructed, so the closure reference is always assigned.
  const store: PgAgentSessionStore = new PgAgentSessionStore(pool, {
    withTransaction: nodePostgresTransaction(pool),
    onSessionCreated: async (transaction, meta): Promise<void> => {
      await store.registerSessionUrls(
        meta.id,
        extractObservedUrls(meta.prompt),
        'user',
        transaction,
      );
    },
    onUserMessagePosted: async (transaction, input): Promise<void> => {
      await store.registerSessionUrls(
        input.session.id,
        extractObservedUrls(input.text),
        'user',
        transaction,
      );
    },
    // Wake the per-session SSE tail (and the running session's runner) in the
    // SAME transaction as the durable append: PG emits NOTIFY only at commit,
    // so the reader wakes exactly when the row becomes visible. Lossy by
    // design — a dropped notification degrades only latency, never
    // correctness, because every stream keeps its fallback poll.
    onSessionEventAppended: (transaction, event): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'session', sessionId: event.sessionId }),
    onOwnerEventAppended: (transaction, event): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'owner', ownerId: event.ownerId }),
    onCancelRequested: (transaction, sessionId): Promise<void> =>
      notifyDurableAgentEvent(transaction, { kind: 'session', sessionId }),
  });
  return store;
}

/**
 * Return the process-wide agent-session store, initializing its schema lazily.
 * Failed initialization is cleared so a later request can retry after the
 * database becomes available.
 */
export function getAgentSessionStore(): Promise<PgAgentSessionStore> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Promise.reject(new Error('Agent runtime requires DATABASE_URL'));
  }
  if (storeState.storePromise && storeState.connectionString === connectionString) {
    return storeState.storePromise;
  }

  storeState.connectionString = connectionString;
  const initialization = createAgentSessionStore(connectionString).catch((error) => {
    if (storeState.storePromise === initialization) {
      storeState.storePromise = undefined;
      storeState.connectionString = undefined;
    }
    throw error;
  });
  storeState.storePromise = initialization;
  return initialization;
}
