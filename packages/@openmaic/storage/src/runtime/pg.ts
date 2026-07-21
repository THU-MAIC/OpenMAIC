/**
 * PostgreSQL RuntimeStore backend over an injected query interface. The module
 * deliberately imports no PostgreSQL driver: node-postgres, PGlite, and host
 * adapters can all supply the small Queryable surface below.
 *
 * `withTransaction` must check out a fresh connection and open a transaction
 * for every call, pin every query in `body` to it, then commit or roll back and
 * release it. READ COMMITTED isolation is assumed. A shortcut such as
 * `(body) => body(sharedClient)` is unsafe because concurrent calls can
 * interleave in one transaction. Payloads are narrowed to plain JSON values
 * that round-trip losslessly through JSONB; values such as Date, Map, nested
 * undefined, non-finite numbers, and strings containing NUL are rejected.
 */
import {
  RUNTIME_DSL_VERSION,
  isChatMessageSkeleton,
  isQuizAttemptSkeleton,
  migrateRuntime,
  needsRuntimeMigration,
  runtimeDslVersionOf,
  validateRuntimeRecord,
  validateRuntimeSession,
} from '@openmaic/dsl';
import type {
  RuntimePayload,
  RuntimeRecord,
  RuntimeRecordInit,
  RuntimeSession,
  RuntimeSessionStatus,
} from '@openmaic/dsl';
import type { RuntimePayloadValidator, RuntimeSessionInit, RuntimeStore } from './types.js';
import { assertJsonValue, isLosslessJsonString } from './json-value.js';

export interface QueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  rows: TRow[];
}

/** The common query surface implemented by a node-postgres Pool/Client and PGlite. */
export interface Queryable {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<TRow>>;
}

export type WithTransaction = <T>(body: (queryable: Queryable) => Promise<T>) => Promise<T>;

export interface PgRuntimeStoreOptions {
  /**
   * On every call, checks out a fresh connection, opens a transaction, pins
   * every query in `body` to it, then commits or rolls back and releases it.
   * READ COMMITTED isolation is assumed. `(body) => body(sharedClient)` is not
   * valid because concurrent calls would interleave within one transaction.
   */
  withTransaction: WithTransaction;
  /** Replaces the default chat / quizAttempt skeleton validator map. */
  payloadValidators?: Record<string, RuntimePayloadValidator>;
}

/** Idempotent schema for the PostgreSQL runtime backend. */
export const RUNTIME_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_sessions_stage_learner_idx
  ON runtime_sessions (stage_id, learner_key);
CREATE INDEX IF NOT EXISTS runtime_sessions_learner_idx
  ON runtime_sessions (learner_key);

CREATE TABLE IF NOT EXISTS runtime_records (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq >= 0),
  scene_id TEXT,
  created_at TEXT NOT NULL,
  data JSONB NOT NULL,
  CONSTRAINT runtime_records_session_seq_unique UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS runtime_records_session_scene_idx
  ON runtime_records (session_id, scene_id);
`;

/**
 * Create the tables owned by this backend when absent. Safe to call repeatedly;
 * changing an existing table requires a real migration.
 */
export async function ensureSchema(queryable: Queryable): Promise<void> {
  // Keep Queryable minimal: PGlite's query() intentionally accepts one
  // statement at a time, while node-postgres also accepts each statement.
  // This split is deliberately simple and would break on semicolons inside SQL
  // string literals; replace it with a migration runner before adding such SQL.
  for (const sql of RUNTIME_PG_SCHEMA.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
}

const DEFAULT_PAYLOAD_VALIDATORS: Record<string, RuntimePayloadValidator> = {
  chat: (payload) =>
    isChatMessageSkeleton(payload)
      ? { valid: true }
      : {
          valid: false,
          errors: [
            {
              path: '/payload',
              message: 'chat payload must match ChatMessageSkeleton (role + content)',
            },
          ],
        },
  quizAttempt: (payload) =>
    isQuizAttemptSkeleton(payload)
      ? { valid: true }
      : {
          valid: false,
          errors: [
            {
              path: '/payload',
              message: 'quizAttempt payload must match QuizAttemptSkeleton (phase + answers)',
            },
          ],
        },
};

interface StoredJsonRow extends Record<string, unknown> {
  data: unknown;
}

interface LastSeqRow extends Record<string, unknown> {
  last_seq: string | number;
}

function assertValid(
  result: { valid: true } | { valid: false; errors: { path: string; message: string }[] },
  label: string,
): void {
  if (result.valid) return;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

function decodeJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('value is not JSON-serializable');
    return encoded;
  } catch (error) {
    throw new Error(`@openmaic/storage: ${label} is not JSON-serializable`, { cause: error });
  }
}

function isFutureRuntimeVersioned(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  return !needsRuntimeMigration(row) && runtimeDslVersionOf(row) !== RUNTIME_DSL_VERSION;
}

function futureSessionError(sessionId: string, row: RuntimeSession): Error {
  return new Error(
    `@openmaic/storage: session ${JSON.stringify(sessionId)} was written at runtime DSL ` +
      `version ${JSON.stringify(runtimeDslVersionOf(row))}, newer than this client's ` +
      `${RUNTIME_DSL_VERSION}`,
  );
}

function migrateSession(row: RuntimeSession): RuntimeSession {
  return needsRuntimeMigration(row) ? (migrateRuntime(row) as RuntimeSession) : row;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

// PostgreSQL text parameters reject NUL and unpaired UTF-16 surrogates before
// SQL can apply absence semantics.
function isPgQueryableKey(value: string): boolean {
  // Shared with the write gate: a key the gate refuses can never be stored,
  // so treating it as absent on the read/delete side is provably sound.
  return isLosslessJsonString(value);
}

// 40001 is not reachable under the READ COMMITTED isolation this store assumes,
// but remains retryable in case a host injects REPEATABLE READ or SERIALIZABLE
// at the connection or session level. appendRecord intentionally owns the only
// write-conflict retry loop: a non-cooperating external writer can deadlock its
// multi-statement lock/read/insert sequence. mergeLearner acquires its complete
// lock set in one statement, so it cannot form a lock-acquisition cycle, while
// setSessionStatus takes only one row lock; neither path needs conflict retries.
function isRetryableAppendError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === '23505' || code === '40001' || code === '40P01';
}

export class PgRuntimeStore implements RuntimeStore {
  private readonly queryable: Queryable;
  private readonly transactionHook: WithTransaction;
  private readonly payloadValidators: Record<string, RuntimePayloadValidator>;

  constructor(queryable: Queryable, options: PgRuntimeStoreOptions) {
    if (typeof options?.withTransaction !== 'function') {
      throw new Error(
        '@openmaic/storage: withTransaction is required and must pin a fresh connection and ' +
          'transaction for every call; reusing a shared client lets concurrent transactions ' +
          'interleave',
      );
    }
    this.queryable = queryable;
    this.transactionHook = options.withTransaction;
    this.payloadValidators = options.payloadValidators ?? DEFAULT_PAYLOAD_VALIDATORS;
  }

  private async transaction<T>(body: (queryable: Queryable) => Promise<T>): Promise<T> {
    return this.transactionHook(body);
  }

  private validatorFor(kind: string): RuntimePayloadValidator | undefined {
    return Object.hasOwn(this.payloadValidators, kind) ? this.payloadValidators[kind] : undefined;
  }

  private async loadSession(
    queryable: Queryable,
    sessionId: string,
    lock = false,
  ): Promise<RuntimeSession | undefined> {
    const result = await queryable.query<StoredJsonRow>(
      `SELECT data
         FROM runtime_sessions
        WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [sessionId],
    );
    const storedRow = result.rows[0];
    if (!storedRow) return undefined;
    const decoded = decodeJson<unknown>(storedRow.data);
    if (!isPlainObject(decoded)) {
      throw new Error(
        `@openmaic/storage: corrupt stored row for session ${JSON.stringify(sessionId)}: ` +
          'data must be a plain object',
      );
    }
    return decoded as RuntimeSession;
  }

  private async persistSession(queryable: Queryable, session: RuntimeSession): Promise<void> {
    await queryable.query(
      `UPDATE runtime_sessions
          SET stage_id = $2,
              learner_key = $3,
              kind = $4,
              status = $5,
              created_at = $6,
              updated_at = $7,
              data = $8::jsonb
        WHERE id = $1`,
      [
        session.id,
        session.stageId,
        session.learnerKey,
        session.kind,
        session.status,
        session.createdAt,
        session.updatedAt,
        encodeJson(session, `runtime session ${JSON.stringify(session.id)}`),
      ],
    );
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    const stamped: RuntimeSession = { ...init, runtimeDslVersion: RUNTIME_DSL_VERSION };
    assertValid(validateRuntimeSession(stamped), `runtime session ${JSON.stringify(stamped.id)}`);
    assertJsonValue(stamped, `runtime session ${JSON.stringify(stamped.id)}`);

    try {
      await this.queryable.query(
        `INSERT INTO runtime_sessions
           (id, stage_id, learner_key, kind, status, created_at, updated_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          stamped.id,
          stamped.stageId,
          stamped.learnerKey,
          stamped.kind,
          stamped.status,
          stamped.createdAt,
          stamped.updatedAt,
          encodeJson(stamped, `runtime session ${JSON.stringify(stamped.id)}`),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new Error(`@openmaic/storage: session ${JSON.stringify(stamped.id)} already exists`, {
          cause: error,
        });
      }
      throw error;
    }
    return stamped;
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    if (!isPgQueryableKey(sessionId)) return undefined;
    const row = await this.loadSession(this.queryable, sessionId);
    if (!row) return undefined;
    const session = migrateSession(row);
    assertValid(
      validateRuntimeSession(session),
      `stored runtime session ${JSON.stringify(sessionId)}`,
    );
    return session;
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    if (!isPgQueryableKey(stageId) || !isPgQueryableKey(learnerKey)) return [];
    const result = await this.queryable.query<StoredJsonRow>(
      `SELECT data
         FROM runtime_sessions
        WHERE stage_id = $1 AND learner_key = $2`,
      [stageId, learnerKey],
    );
    const sessions: RuntimeSession[] = [];
    for (const row of result.rows) {
      try {
        const session = migrateSession(decodeJson<RuntimeSession>(row.data));
        assertValid(
          validateRuntimeSession(session),
          `stored runtime session ${JSON.stringify(session.id)}`,
        );
        sessions.push(session);
      } catch {
        // Listings omit corrupt rows; direct reads remain fail-loud.
      }
    }
    return sessions.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async setSessionStatus(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
  ): Promise<void> {
    if (!isPgQueryableKey(sessionId)) {
      throw new Error(`@openmaic/storage: no session ${JSON.stringify(sessionId)}`);
    }
    await this.transaction(async (queryable) => {
      const row = await this.loadSession(queryable, sessionId, true);
      if (!row) throw new Error(`@openmaic/storage: no session ${JSON.stringify(sessionId)}`);
      if (isFutureRuntimeVersioned(row)) throw futureSessionError(sessionId, row);
      const updated: RuntimeSession = { ...migrateSession(row), status, updatedAt };
      assertValid(validateRuntimeSession(updated), `runtime session ${JSON.stringify(sessionId)}`);
      await this.persistSession(queryable, updated);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!isPgQueryableKey(sessionId)) return;
    await this.queryable.query('DELETE FROM runtime_sessions WHERE id = $1', [sessionId]);
  }

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    assertValid(
      validateRuntimeRecord({ ...init, seq: 0 }),
      `runtime record ${JSON.stringify(init.id)}`,
    );
    assertJsonValue(init.payload, `runtime record ${JSON.stringify(init.id)} payload`);
    if (!isPgQueryableKey(init.sessionId)) {
      // A text column can never hold such a key, so no session can exist.
      throw new Error(`@openmaic/storage: no session ${JSON.stringify(init.sessionId)}`);
    }

    // The session-row lock serializes appenders for one session. Computing
    // MAX(seq)+1 and inserting happen in that same transaction, so rollback
    // cannot leave a hole. UNIQUE(session_id, seq) is the final safety net;
    // retrying the whole transaction handles a competing non-cooperating SQL
    // writer without ever returning a duplicate sequence.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.transaction(async (queryable) => {
          const row = await this.loadSession(queryable, init.sessionId, true);
          if (!row) {
            throw new Error(`@openmaic/storage: no session ${JSON.stringify(init.sessionId)}`);
          }
          if (isFutureRuntimeVersioned(row)) throw futureSessionError(init.sessionId, row);

          let session = row;
          if (needsRuntimeMigration(row)) {
            session = migrateSession(row);
            await this.persistSession(queryable, session);
          }
          if (session.status !== 'active') {
            throw new Error(
              `@openmaic/storage: cannot append to session ${JSON.stringify(init.sessionId)} ` +
                `with status '${session.status}' — records may only be appended to an active session`,
            );
          }
          const validator = this.validatorFor(session.kind);
          if (validator) {
            assertValid(validator(init.payload), `runtime record ${JSON.stringify(init.id)}`);
          }

          const last = await queryable.query<LastSeqRow>(
            `SELECT COALESCE(MAX(seq), -1)::text AS last_seq
               FROM runtime_records
              WHERE session_id = $1`,
            [init.sessionId],
          );
          const seq = Number(last.rows[0]?.last_seq ?? -1) + 1;
          const record: RuntimeRecord<TPayload> = { ...init, seq };
          assertValid(validateRuntimeRecord(record), `runtime record ${JSON.stringify(init.id)}`);
          // Only the DSL-declared optional anchors get omitted-value treatment;
          // any other undefined member still fails the JSON gate loud.
          const jsonRecord = { ...record } as Record<string, unknown>;
          for (const key of ['sceneId', 'actionIndex', 'subAnchor']) {
            if (jsonRecord[key] === undefined) delete jsonRecord[key];
          }
          assertJsonValue(jsonRecord, `runtime record ${JSON.stringify(record.id)}`);
          await queryable.query(
            `INSERT INTO runtime_records
               (id, session_id, seq, scene_id, created_at, data)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
              record.id,
              record.sessionId,
              record.seq,
              record.sceneId ?? null,
              record.createdAt,
              encodeJson(record, `runtime record ${JSON.stringify(record.id)}`),
            ],
          );
          return record;
        });
      } catch (error) {
        // Under the assumed READ COMMITTED isolation, each retry starts a fresh
        // transaction and repeats the locked read, MAX(seq), and INSERT. A
        // failed attempt cannot commit partial effects, so retrying uniqueness,
        // serialization, and deadlock aborts preserves monotonic sequences.
        if (!isRetryableAppendError(error) || attempt === 4) throw error;
      }
    }
    throw new Error('@openmaic/storage: unreachable append retry state');
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    if (
      !isPgQueryableKey(sessionId) ||
      (opts?.sceneId !== undefined && !isPgQueryableKey(opts.sceneId))
    ) {
      return [];
    }
    const params: unknown[] = [sessionId];
    let filter = '';
    if (opts?.sceneId !== undefined) {
      params.push(opts.sceneId);
      filter = ' AND scene_id = $2';
    }
    const result = await this.queryable.query<StoredJsonRow>(
      `SELECT data
         FROM runtime_records
        WHERE session_id = $1${filter}
        ORDER BY seq ASC`,
      params,
    );
    return result.rows.map((row) => decodeJson<RuntimeRecord>(row.data));
  }

  async mergeLearner(fromLearnerKey: string, toLearnerKey: string): Promise<number> {
    if (
      typeof fromLearnerKey !== 'string' ||
      fromLearnerKey === '' ||
      typeof toLearnerKey !== 'string' ||
      toLearnerKey === ''
    ) {
      throw new Error('@openmaic/storage: learner keys must be non-empty strings');
    }
    assertJsonValue(toLearnerKey, 'target learner key');
    if (!isPgQueryableKey(fromLearnerKey)) return 0;
    if (fromLearnerKey === toLearnerKey) return 0;

    // This lock set grows without bound with the source learner's session count,
    // and the following updates hold it across N round-trips. That is a known
    // contention/scalability surface, not a correctness issue; deployments that
    // need to cap the wait can mitigate it with PostgreSQL's lock_timeout.
    return this.transaction(async (queryable) => {
      const result = await queryable.query<StoredJsonRow>(
        `SELECT data
           FROM runtime_sessions
          WHERE learner_key = $1
          FOR UPDATE`,
        [fromLearnerKey],
      );
      const updatedSessions = result.rows.map((row) => {
        const stored = decodeJson<RuntimeSession>(row.data);
        if (isFutureRuntimeVersioned(stored)) throw futureSessionError(stored.id, stored);
        const updated: RuntimeSession = {
          ...migrateSession(stored),
          learnerKey: toLearnerKey,
        };
        assertValid(
          validateRuntimeSession(updated),
          `runtime session ${JSON.stringify(updated.id)}`,
        );
        return updated;
      });
      for (const session of updatedSessions) await this.persistSession(queryable, session);
      return updatedSessions.length;
    });
  }

  async deleteLearnerRuntime(stageId: string, learnerKey: string): Promise<void> {
    if (!isPgQueryableKey(stageId) || !isPgQueryableKey(learnerKey)) return;
    await this.queryable.query(
      'DELETE FROM runtime_sessions WHERE stage_id = $1 AND learner_key = $2',
      [stageId, learnerKey],
    );
  }

  async deleteStageRuntime(stageId: string): Promise<void> {
    if (!isPgQueryableKey(stageId)) return;
    await this.queryable.query('DELETE FROM runtime_sessions WHERE stage_id = $1', [stageId]);
  }

  async deleteAllRuntime(): Promise<void> {
    // Single statement; the FK cascade clears runtime_records with it.
    await this.queryable.query('DELETE FROM runtime_sessions');
  }
}
