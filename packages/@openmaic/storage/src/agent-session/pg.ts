/**
 * PostgreSQL backend for durable agent sessions.
 *
 * The backend imports no database driver. A host supplies a direct queryable
 * and a transaction hook that checks out and pins one connection for the
 * complete callback. READ COMMITTED isolation is assumed by the parent-row
 * lock followed by max-plus-one child allocation used by both append logs.
 */
import { randomUUID } from 'node:crypto';

import type { Queryable, WithTransaction } from '../runtime/pg.js';
import {
  AGENT_SESSION_LIFECYCLE,
  AgentSessionAccessError,
  AgentSessionEntryTreeError,
  AgentSessionLeaseLostError,
  normalizeObservedUrl,
  type AgentSessionEntry,
  type AgentSessionEntryTree,
  type AgentSessionEntryTreeHandle,
  type AgentSessionEventLog,
  type AgentSessionHooks,
  type AgentSessionMeta,
  type AgentSessionStore,
  type AgentSessionTransaction,
  type AgentSessionUrlSource,
  type AgentSessionUrlStore,
  type AgentSessionUserMessage,
  type ClaimedAgentSession,
  type ClaimAgentSessionOptions,
  type CreateAgentSessionInput,
  type FinishAgentSessionPatch,
  type NewAgentSessionEvent,
  type NewOwnerSessionEvent,
  type OwnerSessionEventProjection,
  type PersistedAgentSessionEvent,
  type PersistedOwnerSessionEvent,
  type PostAgentUserMessageOptions,
  type PostAgentUserMessageResult,
} from './types.js';

export type { QueryResult, Queryable, WithTransaction } from '../runtime/pg.js';

export interface AgentSessionTableNames {
  sessions: string;
  events: string;
  entries: string;
  ownerEventCounters: string;
  ownerEvents: string;
  urls: string;
}

export const DEFAULT_AGENT_SESSION_TABLE_NAMES: Readonly<AgentSessionTableNames> = {
  sessions: 'agent_sessions',
  events: 'agent_session_events',
  entries: 'agent_session_entries',
  ownerEventCounters: 'agent_owner_session_event_counters',
  ownerEvents: 'agent_owner_session_events',
  urls: 'agent_session_urls',
};

export interface AgentSessionLogger {
  error(message: string, context: Record<string, unknown>, error: unknown): void;
}

export interface PgAgentSessionStoreOptions extends AgentSessionHooks {
  /**
   * Checks out a fresh connection, begins a transaction, pins every callback
   * query to it, then commits or rolls back before releasing the connection.
   */
  withTransaction: WithTransaction;
  tableNames?: Partial<AgentSessionTableNames>;
  logger?: AgentSessionLogger;
  /** Test seams; production callers normally use the defaults. */
  createId?: () => string;
  now?: () => number;
}

/** Pinned default schema for the PostgreSQL agent-session backend. */
export const AGENT_SESSION_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  stage_id            TEXT NOT NULL,
  active_stage_id     TEXT,
  skill_id            TEXT,
  origin              TEXT,
  existing_course     BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'queued',
  attempt             INTEGER NOT NULL DEFAULT 0,
  delivered_user_message_seq INTEGER NOT NULL DEFAULT 0,
  lease_worker_id     TEXT,
  lease_worker_pid    INTEGER,
  lease_heartbeat_at  BIGINT,
  cancel_requested_at BIGINT,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT agent_sessions_attempt_nonnegative CHECK (attempt >= 0),
  CONSTRAINT agent_sessions_status_known
    CHECK (status IN ('queued','running','succeeded','failed','cancelled'))
);

ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS delivered_user_message_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS agent_sessions_status_live_idx
  ON agent_sessions (status, created_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_sessions_owner_live_idx
  ON agent_sessions (owner_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_session_events (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         BIGINT NOT NULL,
  attempt    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data       JSONB,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_events_seq_positive CHECK (seq > 0)
);

CREATE TABLE IF NOT EXISTS agent_session_entries (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  entry_id   TEXT NOT NULL,
  parent_id  TEXT,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  attempt    INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_entries_entry_id_unique UNIQUE (session_id, entry_id),
  CONSTRAINT agent_session_entries_parent_fk
    FOREIGN KEY (session_id, parent_id)
    REFERENCES agent_session_entries (session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS agent_session_entries_type_idx
  ON agent_session_entries (session_id, type, seq);

CREATE TABLE IF NOT EXISTS agent_owner_session_event_counters (
  owner_id TEXT PRIMARY KEY,
  n        BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT agent_owner_session_event_counters_nonnegative CHECK (n >= 0)
);

CREATE TABLE IF NOT EXISTS agent_owner_session_events (
  owner_id   TEXT NOT NULL,
  id         BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  status     TEXT,
  attempt    INTEGER,
  data       JSONB NOT NULL,
  PRIMARY KEY (owner_id, id),
  CONSTRAINT agent_owner_session_events_type_known CHECK (type IN
    ('session_created','session_status','session_deleted',
     'session_active_stage','session_cancel_requested')),
  CONSTRAINT agent_owner_session_events_status_known CHECK (status IS NULL OR status IN
    ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT agent_owner_session_events_attempt_nonnegative
    CHECK (attempt IS NULL OR attempt >= 0)
);

CREATE TABLE IF NOT EXISTS agent_session_urls (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, url),
  CONSTRAINT agent_session_urls_source_known CHECK (source IN ('user','web_search'))
);

CREATE INDEX IF NOT EXISTS agent_session_urls_session_created_idx
  ON agent_session_urls (session_id, created_at);
`;

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(
      `@openmaic/storage: invalid agent-session table name ${JSON.stringify(identifier)}`,
    );
  }
  return `"${identifier}"`;
}

function resolveTableNames(overrides?: Partial<AgentSessionTableNames>): AgentSessionTableNames {
  const names = { ...DEFAULT_AGENT_SESSION_TABLE_NAMES, ...overrides };
  for (const name of Object.values(names)) quoteIdentifier(name);
  return names;
}

function schemaFor(names: AgentSessionTableNames): string {
  if (
    Object.entries(DEFAULT_AGENT_SESSION_TABLE_NAMES).every(
      ([key, value]) => names[key as keyof AgentSessionTableNames] === value,
    )
  ) {
    return AGENT_SESSION_PG_SCHEMA;
  }
  const s = quoteIdentifier(names.sessions);
  const e = quoteIdentifier(names.events);
  const t = quoteIdentifier(names.entries);
  const c = quoteIdentifier(names.ownerEventCounters);
  const o = quoteIdentifier(names.ownerEvents);
  const u = quoteIdentifier(names.urls);
  // Index names derive from the table-name substitution verbatim: the template
  // index names (`agent_sessions_status_live_idx`, ...) are re-keyed by the
  // same replaceAll that re-keys their tables, so no separate prefix rewriting
  // is performed or needed.
  return AGENT_SESSION_PG_SCHEMA.replaceAll(
    'agent_owner_session_event_counters',
    names.ownerEventCounters,
  )
    .replaceAll('agent_owner_session_events', names.ownerEvents)
    .replaceAll('agent_session_entries', names.entries)
    .replaceAll('agent_session_events', names.events)
    .replaceAll('agent_session_urls', names.urls)
    .replaceAll('agent_sessions', names.sessions)
    .replaceAll(`REFERENCES ${names.sessions}`, `REFERENCES ${s}`)
    .replaceAll(`ON ${names.sessions}`, `ON ${s}`)
    .replaceAll(`ON ${names.entries}`, `ON ${t}`)
    .replaceAll(`CREATE TABLE IF NOT EXISTS ${names.sessions}`, `CREATE TABLE IF NOT EXISTS ${s}`)
    .replaceAll(`CREATE TABLE IF NOT EXISTS ${names.events}`, `CREATE TABLE IF NOT EXISTS ${e}`)
    .replaceAll(`CREATE TABLE IF NOT EXISTS ${names.entries}`, `CREATE TABLE IF NOT EXISTS ${t}`)
    .replaceAll(
      `CREATE TABLE IF NOT EXISTS ${names.ownerEventCounters}`,
      `CREATE TABLE IF NOT EXISTS ${c}`,
    )
    .replaceAll(
      `CREATE TABLE IF NOT EXISTS ${names.ownerEvents}`,
      `CREATE TABLE IF NOT EXISTS ${o}`,
    )
    .replaceAll(`CREATE TABLE IF NOT EXISTS ${names.urls}`, `CREATE TABLE IF NOT EXISTS ${u}`);
}

/** Create all backend-owned tables when absent; existing schemas require migrations. */
export async function ensureAgentSessionSchema(
  queryable: Queryable,
  tableNames?: Partial<AgentSessionTableNames>,
): Promise<void> {
  const schema = schemaFor(resolveTableNames(tableNames));
  for (const sql of schema.split(';')) {
    const statement = sql.trim();
    if (statement !== '') await queryable.query(statement);
  }
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  prompt: string;
  stage_id: string;
  skill_id: string | null;
  origin: string | null;
  existing_course: boolean;
  status: AgentSessionMeta['status'];
  attempt: number;
  delivered_user_message_seq: number;
  lease_worker_id: string | null;
  lease_worker_pid: number | null;
  lease_heartbeat_at: number | string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const SESSION_COLUMNS = `id, owner_id, prompt, stage_id, skill_id, origin,
  existing_course, status, attempt, delivered_user_message_seq, lease_worker_id, lease_worker_pid,
  lease_heartbeat_at, error, created_at, updated_at`;

function epoch(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** WHATWG origin (scheme + host + port, default ports dropped); null when unparseable. */
function urlOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function sessionMeta(row: SessionRow): AgentSessionMeta {
  return {
    id: row.id,
    ownerId: row.owner_id,
    prompt: row.prompt,
    stageId: row.stage_id,
    ...(row.skill_id ? { skillId: row.skill_id } : {}),
    ...(row.origin ? { origin: row.origin } : {}),
    existingCourse: row.existing_course,
    status: row.status,
    attempt: Number(row.attempt),
    deliveredUserMessageSeq: Number(row.delivered_user_message_seq),
    createdAt: epoch(row.created_at),
    updatedAt: epoch(row.updated_at),
    ...(row.lease_worker_id
      ? {
          lease: {
            workerId: row.lease_worker_id,
            workerPid: row.lease_worker_pid ?? 0,
            heartbeatAt: Number(row.lease_heartbeat_at ?? 0),
          },
        }
      : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value === undefined ? null : value);
    if (encoded === undefined) throw new TypeError('value is not JSON-serializable');
    return encoded;
  } catch (error) {
    throw new Error(`@openmaic/storage: ${label} is not JSON-serializable`, { cause: error });
  }
}

function decodedObject(value: unknown): Record<string, unknown> {
  const decoded = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return decoded && typeof decoded === 'object' ? (decoded as Record<string, unknown>) : {};
}

let savepointSerial = 0;

export class PgAgentSessionStore
  implements
    AgentSessionStore,
    AgentSessionEventLog,
    AgentSessionEntryTree,
    OwnerSessionEventProjection,
    AgentSessionUrlStore
{
  private readonly queryable: Queryable;
  private readonly transactionHook: WithTransaction;
  private readonly tables: AgentSessionTableNames;
  private readonly logger: AgentSessionLogger;
  private readonly createId: () => string;
  private readonly clock: () => number;
  private readonly resolveOwnerHook: NonNullable<AgentSessionHooks['resolveFinalOwner']>;
  private readonly createdHook?: AgentSessionHooks['onSessionCreated'];
  private readonly messageHook?: AgentSessionHooks['onUserMessagePosted'];
  private readonly sessionEventHook?: AgentSessionHooks['onSessionEventAppended'];
  private readonly ownerEventHook?: AgentSessionHooks['onOwnerEventAppended'];
  private readonly cancelHook?: AgentSessionHooks['onCancelRequested'];

  constructor(queryable: Queryable, options: PgAgentSessionStoreOptions) {
    if (typeof options?.withTransaction !== 'function') {
      throw new Error(
        '@openmaic/storage: withTransaction is required and must pin a fresh connection and ' +
          'transaction for every call',
      );
    }
    this.queryable = queryable;
    this.transactionHook = options.withTransaction;
    this.tables = resolveTableNames(options.tableNames);
    this.logger =
      options.logger ??
      ({
        error: (message, context, error) => console.error(message, context, error),
      } satisfies AgentSessionLogger);
    this.createId = options.createId ?? randomUUID;
    this.clock = options.now ?? Date.now;
    this.resolveOwnerHook = options.resolveFinalOwner ?? (async (_tx, ownerId) => ownerId);
    this.createdHook = options.onSessionCreated;
    this.messageHook = options.onUserMessagePosted;
    this.sessionEventHook = options.onSessionEventAppended;
    this.ownerEventHook = options.onOwnerEventAppended;
    this.cancelHook = options.onCancelRequested;
  }

  private table(name: keyof AgentSessionTableNames): string {
    return quoteIdentifier(this.tables[name]);
  }

  private transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.transactionHook(body);
  }

  private async loadSession(
    queryable: Queryable,
    sessionId: string,
    lock = false,
    includeDeleted = false,
  ): Promise<SessionRow | undefined> {
    const result = await queryable.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM ${this.table('sessions')}
       WHERE id = $1${includeDeleted ? '' : ' AND deleted_at IS NULL'}${lock ? ' FOR UPDATE' : ''}`,
      [sessionId],
    );
    return result.rows[0];
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSessionMeta> {
    const id = input.id ?? this.createId();
    return this.transaction(async (tx) => {
      const ownerId = await this.resolveOwnerHook(tx, input.ownerId);
      const result = await tx.query<SessionRow>(
        `INSERT INTO ${this.table('sessions')}
          (id, owner_id, prompt, stage_id, skill_id, origin, existing_course, status, attempt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
         RETURNING ${SESSION_COLUMNS}`,
        [
          id,
          ownerId,
          input.prompt,
          input.stageId ?? `stage-${id.slice(0, 8)}`,
          input.skillId ?? null,
          input.origin ?? null,
          input.existingCourse ?? false,
          input.status ?? 'queued',
        ],
      );
      const meta = sessionMeta(result.rows[0]!);
      await this.createdHook?.(tx, meta);
      await this.appendProjection(
        {
          type: 'session_created',
          sessionId: id,
          ts: this.clock(),
          status: meta.status,
          attempt: 0,
        },
        tx,
      );
      return meta;
    });
  }

  async getSession(sessionId: string): Promise<AgentSessionMeta | null> {
    const row = await this.loadSession(this.queryable, sessionId);
    return row ? sessionMeta(row) : null;
  }

  async listSessionsByOwner(ownerId: string): Promise<AgentSessionMeta[]> {
    const result = await this.queryable.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM ${this.table('sessions')}
       WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
      [ownerId],
    );
    return result.rows.map(sessionMeta);
  }

  async softDeleteSession(sessionId: string, ownerId: string): Promise<boolean> {
    return this.transaction(async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE ${this.table('sessions')}
         SET deleted_at = now(), updated_at = now()
         WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING id`,
        [sessionId, ownerId],
      );
      if (!result.rows[0]) return false;
      await this.appendProjection({ type: 'session_deleted', sessionId, ts: this.clock() }, tx);
      return true;
    });
  }

  /**
   * Attempt charging is per takeover: queued claims and abandoned (non-null
   * stale lease) takeovers increment `attempt`; clean-park (null lease)
   * takeovers do not. Full contract in {@link AgentSessionStore}.
   */
  async claimNextSession(
    workerId: string,
    workerPid: number,
    options: ClaimAgentSessionOptions,
  ): Promise<ClaimedAgentSession | null> {
    const staleBefore = this.clock() - options.leaseTtlMs;
    const params: unknown[] = [staleBefore, workerId, options.maxAttempts + 1];
    const targeted = options.sessionId ? ` AND id = $${params.push(options.sessionId)}` : '';
    // A successful ask_user is durable in the event log before the run settles.
    // Textless user messages may carry newly attached materials, but they are
    // not answers. Keep such work queued until a later nonblank user message
    // answers or supersedes the question. This predicate is repeated after the
    // row lock below; the locked check is the authority, while this one keeps
    // fenced rows out of the optimistic candidate batch.
    const askAdmission = `
         AND (cancel_requested_at IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM ${this.table('events')} question
           WHERE question.session_id = ${this.table('sessions')}.id
             AND question.type = '${AGENT_SESSION_LIFECYCLE.userQuestion}'
             AND NOT EXISTS (
               SELECT 1 FROM ${this.table('events')} answer
               WHERE answer.session_id = question.session_id
                 AND answer.seq > question.seq
                 AND answer.type = '${AGENT_SESSION_LIFECYCLE.userMessage}'
                 AND length(btrim(COALESCE(answer.data->>'text', ''))) > 0
             )
         ))`;
    const candidates = await this.queryable.query<{ id: string }>(
      `SELECT id FROM ${this.table('sessions')}
       WHERE deleted_at IS NULL
         AND (status = 'queued' OR
              (status = 'running'
               AND (lease_heartbeat_at IS NULL OR lease_heartbeat_at < $1)
               AND (lease_worker_id IS NULL OR lease_worker_id <> $2)))
         AND (attempt < $3 OR status = 'running')${askAdmission}${targeted}
       ORDER BY created_at LIMIT 5`,
      params,
    );
    for (const candidate of candidates.rows) {
      const claimed = await this.transaction(async (tx) => {
        const locked = await tx.query<{
          status: string;
          attempt: number;
          cancel_requested_at: number | string | Date | null;
        }>(
          `SELECT status, attempt, cancel_requested_at FROM ${this.table('sessions')}
           WHERE id = $1 AND deleted_at IS NULL
             AND (status = 'queued' OR
                  (status = 'running'
                   AND (lease_heartbeat_at IS NULL OR lease_heartbeat_at < $2)
                   AND (lease_worker_id IS NULL OR lease_worker_id <> $3)))
             AND (attempt < $4 OR status = 'running')
             ${askAdmission}
           FOR UPDATE`,
          [candidate.id, staleBefore, workerId, options.maxAttempts + 1],
        );
        const previous = locked.rows[0];
        if (!previous) return null;
        const now = this.clock();
        // A cancel request is terminal: the session must never be re-leased
        // for another attempt (a restart would otherwise resurrect a session
        // the user already cancelled). Settle it as cancelled under the same
        // lock the claim would have used, then keep scanning.
        if (previous.cancel_requested_at !== null && previous.cancel_requested_at !== undefined) {
          await this.settleCancelledAtClaim(tx, candidate.id, now, previous.attempt);
          return null;
        }
        // PostgreSQL evaluates every SET expression from the locked pre-update
        // row, so lease_worker_id still identifies the prior holder here.
        const updated = await tx.query<SessionRow>(
          `UPDATE ${this.table('sessions')}
           SET status = 'running',
               attempt = attempt + CASE
                 WHEN status = 'queued'
                   OR (status = 'running' AND lease_worker_id IS NOT NULL) THEN 1
                 ELSE 0
               END,
               lease_worker_id = $2,
               lease_worker_pid = $3, lease_heartbeat_at = $4, error = NULL, updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL RETURNING ${SESSION_COLUMNS}`,
          [candidate.id, workerId, workerPid, now],
        );
        const row = updated.rows[0];
        if (!row) return null;
        await this.appendProjection(
          {
            type: 'session_status',
            sessionId: candidate.id,
            ts: now,
            status: 'running',
            attempt: Number(row.attempt),
          },
          tx,
        );
        const seq = await tx.query<{ max: number | string | null }>(
          `SELECT max(seq) AS max FROM ${this.table('events')} WHERE session_id = $1`,
          [candidate.id],
        );
        return {
          ...sessionMeta(row),
          claimReason: previous.status === 'queued' ? 'queued' : 'orphaned',
          claimSeq: Number(seq.rows[0]?.max ?? 0),
        } as ClaimedAgentSession;
      });
      if (claimed) return claimed;
    }
    return null;
  }

  /**
   * Terminal bookkeeping for a cancel-requested session the claim scan just
   * encountered, mirroring what the runner's own cancel path does: the row
   * settles as `cancelled` with the attempt reset and the cancel request
   * cleared, the owner projection records the terminal status, and the event
   * log receives a `session_end` frame so the stream shows the terminal
   * transition even though no lease holder ever ran this attempt.
   */
  private async settleCancelledAtClaim(
    tx: Queryable,
    sessionId: string,
    now: number,
    attempt: number,
  ): Promise<void> {
    const result = await tx.query<SessionRow>(
      `UPDATE ${this.table('sessions')}
       SET status = 'cancelled', attempt = 0, error = NULL,
           lease_worker_id = NULL, lease_worker_pid = NULL, lease_heartbeat_at = NULL,
           cancel_requested_at = NULL, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL AND cancel_requested_at IS NOT NULL
       RETURNING ${SESSION_COLUMNS}`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) return;
    await this.appendProjection(
      { type: 'session_status', sessionId, ts: now, status: 'cancelled', attempt: 0 },
      tx,
    );
    await this.insertEvent(tx, sessionId, {
      ts: now,
      attempt,
      type: AGENT_SESSION_LIFECYCLE.sessionEnd,
      data: { status: 'cancelled' },
    });
  }

  async heartbeat(sessionId: string, workerId: string): Promise<boolean> {
    const result = await this.queryable.query<{ id: string }>(
      `UPDATE ${this.table('sessions')}
       SET lease_heartbeat_at = $3, updated_at = now()
       WHERE id = $1 AND lease_worker_id = $2 AND deleted_at IS NULL RETURNING id`,
      [sessionId, workerId, this.clock()],
    );
    return result.rows.length > 0;
  }

  async markUserMessageDelivered(
    sessionId: string,
    workerId: string,
    attempt: number,
    messageSeq: number,
  ): Promise<boolean> {
    const result = await this.queryable.query<{ id: string }>(
      `UPDATE ${this.table('sessions')}
       SET delivered_user_message_seq = GREATEST(delivered_user_message_seq, $4),
           updated_at = now()
       WHERE id = $1 AND lease_worker_id = $2 AND attempt = $3
         AND deleted_at IS NULL RETURNING id`,
      [sessionId, workerId, attempt, messageSeq],
    );
    return result.rows.length > 0;
  }

  async assertActiveLease(
    sessionId: string,
    workerId: string,
    attempt: number,
    transaction: AgentSessionTransaction,
  ): Promise<void> {
    const result = await transaction.query<{ attempt: number }>(
      `SELECT attempt FROM ${this.table('sessions')}
       WHERE id = $1 AND lease_worker_id = $2 AND attempt = $3
         AND cancel_requested_at IS NULL AND deleted_at IS NULL
       FOR SHARE`,
      [sessionId, workerId, attempt],
    );
    if (!result.rows[0]) throw new AgentSessionLeaseLostError(sessionId, workerId, attempt);
  }

  async finishSession(
    sessionId: string,
    workerId: string,
    patch: FinishAgentSessionPatch,
  ): Promise<boolean> {
    const release = patch.releaseLease !== false;
    return this.transaction(async (tx) => {
      const result = await tx.query<{ attempt: number }>(
        `UPDATE ${this.table('sessions')}
         SET status = $3, error = CASE WHEN $4::boolean THEN $5 ELSE error END,
             lease_worker_id = CASE WHEN $6::boolean THEN NULL ELSE lease_worker_id END,
             lease_worker_pid = CASE WHEN $6::boolean THEN NULL ELSE lease_worker_pid END,
             lease_heartbeat_at = CASE WHEN $6::boolean THEN NULL ELSE lease_heartbeat_at END,
             attempt = CASE WHEN $7::boolean THEN 0 ELSE attempt END,
             cancel_requested_at = CASE
               WHEN $8::bigint IS NOT NULL AND cancel_requested_at = $8 THEN NULL
               ELSE cancel_requested_at
             END,
             updated_at = now()
         WHERE id = $1 AND lease_worker_id = $2 AND deleted_at IS NULL
           AND ($8::bigint IS NULL OR cancel_requested_at = $8)
           AND ($9::integer IS NULL OR attempt = $9)
         RETURNING attempt`,
        [
          sessionId,
          workerId,
          patch.status,
          patch.error !== undefined,
          patch.error ?? null,
          release,
          patch.resetAttempt === true,
          patch.consumeCancelRequestedAt ?? null,
          patch.expectedAttempt ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) return false;
      await this.appendProjection(
        {
          type: 'session_status',
          sessionId,
          ts: this.clock(),
          status: patch.status,
          attempt: Number(row.attempt),
        },
        tx,
      );
      return true;
    });
  }

  async releaseLease(sessionId: string, workerId: string): Promise<void> {
    await this.queryable.query(
      `UPDATE ${this.table('sessions')}
       SET lease_worker_id = NULL, lease_worker_pid = NULL, lease_heartbeat_at = NULL,
           updated_at = now()
       WHERE id = $1 AND lease_worker_id = $2 AND deleted_at IS NULL`,
      [sessionId, workerId],
    );
  }

  private async lockForAppend(
    tx: Queryable,
    sessionId: string,
    workerId: string | null,
  ): Promise<{ owner_id: string; status: AgentSessionMeta['status']; attempt: number } | null> {
    const result = await tx.query<{
      owner_id: string;
      status: AgentSessionMeta['status'];
      attempt: number;
    }>(
      `SELECT owner_id, status, attempt FROM ${this.table('sessions')}
       WHERE id = $1 AND deleted_at IS NULL${workerId === null ? '' : ' AND lease_worker_id = $2'}
       FOR UPDATE`,
      workerId === null ? [sessionId] : [sessionId, workerId],
    );
    return result.rows[0] ?? null;
  }

  private async insertEvent(
    tx: Queryable,
    sessionId: string,
    event: NewAgentSessionEvent,
  ): Promise<number> {
    const result = await tx.query<{ seq: number }>(
      `INSERT INTO ${this.table('events')} (session_id, seq, ts, attempt, type, data)
       SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5::jsonb
       FROM ${this.table('events')} WHERE session_id = $1 RETURNING seq`,
      [sessionId, event.ts, event.attempt, event.type, encodeJson(event.data, 'event data')],
    );
    const seq = Number(result.rows[0]!.seq);
    // Transactional wakeup: the host queues a lossy NOTIFY on the SAME
    // transaction, so the SSE tail and the runner wake exactly when this row
    // commits. PG delivers NOTIFY only at commit, so no reader can observe
    // the wakeup before the row is durable (reference material-event
    // semantics).
    await this.sessionEventHook?.(tx, {
      sessionId,
      seq,
      type: event.type,
      ts: event.ts,
      attempt: event.attempt,
    });
    return seq;
  }

  async appendRunEvent(
    sessionId: string,
    workerId: string,
    event: NewAgentSessionEvent,
  ): Promise<number | null> {
    return this.transaction(async (tx) => {
      const parent = await this.lockForAppend(tx, sessionId, workerId);
      if (!parent || Number(parent.attempt) !== event.attempt) return null;
      return this.insertEvent(tx, sessionId, event);
    });
  }

  async appendControlEvent(
    sessionId: string,
    event: Omit<NewAgentSessionEvent, 'attempt'>,
  ): Promise<number | null> {
    return this.transaction(async (tx) => {
      const parent = await this.lockForAppend(tx, sessionId, null);
      if (!parent) return null;
      // The stored attempt is the current generation under the row lock
      // (reference material-event semantics), never a host-chosen value.
      return this.insertEvent(tx, sessionId, {
        ...event,
        attempt: Number(parent.attempt),
      });
    });
  }

  async appendUserMessage(
    sessionId: string,
    input: { text: string; delivery: 'steer' | 'queued'; clientRequestId?: string },
  ): Promise<number> {
    return this.transaction(async (tx) => {
      const parent = await this.lockForAppend(tx, sessionId, null);
      if (!parent)
        throw new Error(`@openmaic/storage: unknown session ${JSON.stringify(sessionId)}`);
      return this.insertEvent(tx, sessionId, {
        ts: this.clock(),
        attempt: 0,
        type: AGENT_SESSION_LIFECYCLE.userMessage,
        data: input,
      });
    });
  }

  async postUserMessage(
    sessionId: string,
    input: {
      text: string;
      materials?: unknown[];
      elementRefs?: unknown[];
      courseRefs?: unknown[];
    },
    options: PostAgentUserMessageOptions = {},
  ): Promise<PostAgentUserMessageResult> {
    const clientRequestId = this.createId();
    return this.transaction(async (tx) => {
      if (options.expectedOwnerId) {
        const finalOwner = await this.resolveOwnerHook(tx, options.expectedOwnerId);
        if (finalOwner !== options.expectedOwnerId) throw new AgentSessionAccessError(sessionId);
      }
      const parent = await this.lockForAppend(tx, sessionId, null);
      if (!parent)
        throw new Error(`@openmaic/storage: unknown session ${JSON.stringify(sessionId)}`);
      if (options.expectedOwnerId && parent.owner_id !== options.expectedOwnerId) {
        throw new AgentSessionAccessError(sessionId);
      }
      const pendingAsk = await tx.query<{ pending: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM ${this.table('events')} question
           WHERE question.session_id = $1
             AND question.type = $2
             AND NOT EXISTS (
               SELECT 1 FROM ${this.table('events')} answer
               WHERE answer.session_id = question.session_id
                 AND answer.seq > question.seq
                 AND answer.type = $3
                 AND length(btrim(COALESCE(answer.data->>'text', ''))) > 0
             )
         ) AS pending`,
        [sessionId, AGENT_SESSION_LIFECYCLE.userQuestion, AGENT_SESSION_LIFECYCLE.userMessage],
      );
      // Once ask_user is durable, even a textual answer belongs to the next
      // turn. Label it queued so the UI and wake drain do not promise a steer
      // into the run whose terminal question it is answering.
      const live = parent.status === 'running' && pendingAsk.rows[0]?.pending !== true;
      const delivery = live ? 'steer' : 'queued';
      const seq = await this.insertEvent(tx, sessionId, {
        ts: this.clock(),
        attempt: 0,
        type: AGENT_SESSION_LIFECYCLE.userMessage,
        data: {
          text: input.text,
          delivery,
          clientRequestId,
          ...(input.materials?.length ? { materials: input.materials } : {}),
          ...(input.elementRefs?.length ? { elementRefs: input.elementRefs } : {}),
          ...(input.courseRefs?.length ? { courseRefs: input.courseRefs } : {}),
        },
      });
      const row = await this.loadSession(tx, sessionId, false);
      // The hook is a deliberate veto point (reference semantics): a throw
      // rolls back the staged message and any requeue, and the caller must
      // retry. The event only becomes durable at COMMIT.
      await this.messageHook?.(tx, {
        session: sessionMeta(row!),
        text: input.text,
        seq,
        delivery,
        clientRequestId,
      });
      let requeued = false;
      if (parent.status === 'queued') {
        await tx.query(
          `UPDATE ${this.table('sessions')}
           SET attempt = 0, error = NULL, cancel_requested_at = NULL, updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL`,
          [sessionId],
        );
        await this.appendProjection(
          { type: 'session_status', sessionId, ts: this.clock(), status: 'queued', attempt: 0 },
          tx,
        );
      } else if (!live) {
        requeued = await this.requeueIn(tx, sessionId, true);
      }
      return { seq, delivery, requeued };
    });
  }

  async listUserMessages(sessionId: string): Promise<AgentSessionUserMessage[]> {
    const result = await this.queryable.query<{
      seq: number;
      ts: number | string;
      data: unknown;
    }>(
      `SELECT e.seq, e.ts, e.data FROM ${this.table('events')} e
       INNER JOIN ${this.table('sessions')} s ON s.id = e.session_id
       WHERE e.session_id = $1 AND e.type = $2 AND s.deleted_at IS NULL ORDER BY e.seq`,
      [sessionId, AGENT_SESSION_LIFECYCLE.userMessage],
    );
    return result.rows.map((row) => {
      const data = decodedObject(row.data);
      return {
        seq: Number(row.seq),
        ts: Number(row.ts),
        text: String(data.text ?? ''),
        delivery: String(data.delivery ?? ''),
        materials: Array.isArray(data.materials) ? data.materials : [],
        ...(Array.isArray(data.courseRefs) ? { courseRefs: data.courseRefs } : {}),
      };
    });
  }

  async lastEventSeq(sessionId: string): Promise<number> {
    const result = await this.queryable.query<{ max: number | string | null }>(
      `SELECT max(e.seq) AS max FROM ${this.table('events')} e
       INNER JOIN ${this.table('sessions')} s ON s.id = e.session_id
       WHERE e.session_id = $1 AND s.deleted_at IS NULL`,
      [sessionId],
    );
    return Number(result.rows[0]?.max ?? 0);
  }

  async readEventsAfter(
    sessionId: string,
    afterSeq: number,
    limit = 500,
  ): Promise<PersistedAgentSessionEvent[]> {
    const result = await this.queryable.query<{
      seq: number;
      ts: number | string;
      attempt: number;
      type: string;
      data: unknown;
    }>(
      `SELECT e.seq, e.ts, e.attempt, e.type, e.data
       FROM ${this.table('events')} e
       INNER JOIN ${this.table('sessions')} s ON s.id = e.session_id
       WHERE e.session_id = $1 AND e.seq > $2 AND s.deleted_at IS NULL
       ORDER BY e.seq LIMIT $3`,
      [sessionId, afterSeq, limit],
    );
    return result.rows.map((row) => ({
      id: Number(row.seq),
      ts: Number(row.ts),
      attempt: Number(row.attempt),
      type: row.type,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    }));
  }

  async readEventsAfterForReplay(
    sessionId: string,
    afterSeq: number,
    limit = 500,
  ): Promise<{ events: PersistedAgentSessionEvent[]; scanned: number }> {
    // Drops intermediate `message_update` tokens so a session that streamed
    // tens of thousands of deltas does not ship them all to the browser on
    // refresh — but keeps the FIRST and the LAST of each page: the last
    // carries the full text, the first is what makes the live tail forward a
    // delta the moment it lands (its `prev` is NULL at the page edge, so it
    // can never be compacted away). The window functions rank the bounded
    // PAGE, not the whole remainder of the log: the live tail polls this
    // every couple of hundred milliseconds, and ranking the entire tail on
    // each poll was the stream's biggest cost. A compaction judgment at a
    // page edge sees no neighbour across the boundary and keeps the extra
    // frame — a harmless middle frame the fold overwrites (reference
    // semantics).
    //
    // `scanned` is the RAW page size before compaction, so the caller's
    // pagination ("a full page means more log remains") stays exact.
    const result = await this.queryable.query<{
      seq: number;
      ts: number | string;
      attempt: number;
      type: string;
      data: unknown;
      scanned: number | string;
    }>(
      `WITH page AS (
         SELECT e.seq, e.ts, e.attempt, e.type, e.data, count(*) OVER () AS scanned
         FROM ${this.table('events')} e
         WHERE e.session_id = $1 AND e.seq > $2
           AND EXISTS (SELECT 1 FROM ${this.table('sessions')} s
                       WHERE s.id = $1 AND s.deleted_at IS NULL)
         ORDER BY e.seq LIMIT $3
       ), ranked AS (
         SELECT seq, lag(type) OVER (ORDER BY seq) AS prev_type,
                lead(type) OVER (ORDER BY seq) AS next_type FROM page
       )
       SELECT p.seq, p.ts, p.attempt, p.type, p.data, p.scanned
       FROM page p INNER JOIN ranked r ON r.seq = p.seq
       WHERE p.type <> 'message_update'
          OR r.prev_type IS DISTINCT FROM 'message_update'
          OR r.next_type IS DISTINCT FROM 'message_update'
       ORDER BY p.seq`,
      [sessionId, afterSeq, limit],
    );
    return {
      events: result.rows.map((row) => ({
        id: Number(row.seq),
        ts: Number(row.ts),
        attempt: Number(row.attempt),
        type: row.type,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      })),
      scanned: Number(result.rows[0]?.scanned ?? 0),
    };
  }

  async hasSessionRunHistory(sessionId: string): Promise<boolean> {
    const types = [
      AGENT_SESSION_LIFECYCLE.sessionStart,
      AGENT_SESSION_LIFECYCLE.sessionResumed,
      AGENT_SESSION_LIFECYCLE.sessionInterrupted,
      AGENT_SESSION_LIFECYCLE.sessionEnd,
    ];
    const result = await this.queryable.query<{ present: number }>(
      `SELECT 1 AS present FROM ${this.table('events')} e
       INNER JOIN ${this.table('sessions')} s ON s.id = e.session_id
       WHERE e.session_id = $1 AND e.type = ANY($2::text[]) AND s.deleted_at IS NULL LIMIT 1`,
      [sessionId, types],
    );
    return result.rows.length > 0;
  }

  private async requeueIn(tx: Queryable, sessionId: string, reset: boolean): Promise<boolean> {
    const result = await tx.query<{ attempt: number }>(
      `UPDATE ${this.table('sessions')}
       SET status = 'queued', attempt = CASE WHEN $2::boolean THEN 0 ELSE attempt END,
           error = NULL, cancel_requested_at = NULL, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
         AND status IN ('succeeded', 'failed', 'cancelled') RETURNING attempt`,
      [sessionId, reset],
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.appendProjection(
      {
        type: 'session_status',
        sessionId,
        ts: this.clock(),
        status: 'queued',
        attempt: Number(row.attempt),
      },
      tx,
    );
    return true;
  }

  async requeueSession(sessionId: string): Promise<boolean> {
    return this.transaction((tx) => this.requeueIn(tx, sessionId, true));
  }

  async requeueForRetry(sessionId: string): Promise<boolean> {
    return this.transaction((tx) => this.requeueIn(tx, sessionId, false));
  }

  async requestCancel(sessionId: string): Promise<void> {
    await this.transaction(async (tx) => {
      const ts = this.clock();
      const result = await tx.query<{ id: string }>(
        `UPDATE ${this.table('sessions')}
         SET cancel_requested_at = $2, updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL AND cancel_requested_at IS NULL RETURNING id`,
        [sessionId, ts],
      );
      if (result.rows[0]) {
        await this.appendProjection({ type: 'session_cancel_requested', sessionId, ts }, tx);
        // The session-route wakeup reaches the running session's runner (and
        // its per-session SSE reader) at COMMIT, so an abort lands within
        // milliseconds instead of on the fallback poll (reference semantics).
        await this.cancelHook?.(tx, sessionId);
      }
    });
  }

  async isCancelRequested(sessionId: string): Promise<boolean> {
    return (await this.getCancelRequestedAt(sessionId)) !== null;
  }

  async getCancelRequestedAt(sessionId: string): Promise<number | null> {
    const result = await this.queryable.query<{ requested_at: number | string | null }>(
      `SELECT cancel_requested_at AS requested_at FROM ${this.table('sessions')}
       WHERE id = $1 AND deleted_at IS NULL`,
      [sessionId],
    );
    const value = result.rows[0]?.requested_at;
    return value === null || value === undefined ? null : Number(value);
  }

  async clearCancel(
    sessionId: string,
    workerId: string,
    attempt: number,
    expectedRequestedAt: number,
  ): Promise<boolean> {
    const result = await this.queryable.query<{ id: string }>(
      `UPDATE ${this.table('sessions')}
       SET cancel_requested_at = NULL, updated_at = now()
       WHERE id = $1 AND lease_worker_id = $2 AND attempt = $3
         AND cancel_requested_at = $4 AND deleted_at IS NULL RETURNING id`,
      [sessionId, workerId, attempt, expectedRequestedAt],
    );
    return result.rows.length > 0;
  }

  async registerSessionUrls(
    sessionId: string,
    values: string[],
    source: AgentSessionUrlSource,
    transaction?: AgentSessionTransaction,
  ): Promise<string[]> {
    const urls = [
      ...new Set(values.map(normalizeObservedUrl).filter((url): url is string => !!url)),
    ];
    if (urls.length === 0) return [];
    const target: Queryable = transaction ?? this.queryable;
    const valueRows = urls
      .map((_url, index) => `($1, $${index * 2 + 2}, $${index * 2 + 3})`)
      .join(', ');
    await target.query(
      `INSERT INTO ${this.table('urls')} (session_id, url, source)
       SELECT observed.session_id, observed.url, observed.source
         FROM (VALUES ${valueRows}) AS observed(session_id, url, source)
         JOIN ${this.table('sessions')} AS sessions
           ON sessions.id = observed.session_id AND sessions.deleted_at IS NULL
       ON CONFLICT (session_id, url) DO NOTHING`,
      [sessionId, ...urls.flatMap((url) => [url, source])],
    );
    return urls;
  }

  /**
   * Rows are pulled into JS and compared by WHATWG origin, which normalizes
   * default ports and never treats a string prefix like `https://arxiv.org` as
   * matching `https://arxiv.org.evil.com`. Per session this is a few hundred
   * rows at most, which is negligible for a fetch_url gate.
   */
  async isSessionUrlAllowed(sessionId: string, value: string): Promise<boolean> {
    const url = normalizeObservedUrl(value);
    if (!url) return false;
    const candidateOrigin = new URL(url).origin;
    const result = await this.queryable.query<{ url: string }>(
      `SELECT urls.url
         FROM ${this.table('urls')} AS urls
         JOIN ${this.table('sessions')} AS sessions
           ON sessions.id = urls.session_id AND sessions.deleted_at IS NULL
        WHERE urls.session_id = $1`,
      [sessionId],
    );
    return result.rows.some((row) => urlOrigin(row.url) === candidateOrigin);
  }

  async openEntryTree(
    sessionId: string,
    workerId: string,
    attempt: number,
  ): Promise<AgentSessionEntryTreeHandle> {
    const session = await this.loadSession(this.queryable, sessionId);
    if (!session)
      throw new Error(`@openmaic/storage: unknown session ${JSON.stringify(sessionId)}`);
    const result = await this.queryable.query<{
      entry_id: string;
      parent_id: string | null;
      type: string;
      data: unknown;
      ts: Date | string;
    }>(
      `SELECT entry_id, parent_id, type, data, ts FROM ${this.table('entries')}
       WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );
    const entries = result.rows.map((row) => ({
      ...decodedObject(row.data),
      id: row.entry_id,
      parentId: row.parent_id,
      type: row.type,
      timestamp: (row.ts instanceof Date ? row.ts : new Date(row.ts)).toISOString(),
    })) as AgentSessionEntry[];
    return new PgAgentSessionEntryTreeHandle(this, sessionId, workerId, attempt, entries);
  }

  async appendTreeEntry(
    sessionId: string,
    workerId: string,
    attempt: number,
    entry: AgentSessionEntry,
  ): Promise<void> {
    const { id, parentId, type, timestamp, ...data } = entry;
    if (!id || !type || !Number.isFinite(new Date(timestamp).getTime())) {
      throw new AgentSessionEntryTreeError(
        sessionId,
        'entry identity, type, or timestamp is invalid',
      );
    }
    await this.transaction(async (tx) => {
      const parent = await this.lockForAppend(tx, sessionId, workerId);
      if (!parent || Number(parent.attempt) !== attempt) {
        throw new AgentSessionLeaseLostError(sessionId, workerId, attempt);
      }
      await tx.query(
        `INSERT INTO ${this.table('entries')}
          (session_id, seq, entry_id, parent_id, type, data, ts, attempt)
         SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5::jsonb, $6, $7
         FROM ${this.table('entries')} WHERE session_id = $1`,
        [sessionId, id, parentId, type, encodeJson(data, 'entry data'), timestamp, attempt],
      );
    });
  }

  async append(
    event: NewOwnerSessionEvent,
    transaction: AgentSessionTransaction,
  ): Promise<bigint | null> {
    return this.appendProjection(event, transaction);
  }

  private async appendProjection(
    event: NewOwnerSessionEvent,
    transaction: AgentSessionTransaction,
  ): Promise<bigint | null> {
    const savepoint = `agent_session_projection_${(savepointSerial += 1)}`;
    try {
      await transaction.query(`SAVEPOINT ${savepoint}`);
      const locked = await transaction.query<{ owner_id: string }>(
        `SELECT owner_id FROM ${this.table('sessions')} WHERE id = $1 FOR UPDATE`,
        [event.sessionId],
      );
      const session = locked.rows[0];
      if (!session) throw new Error(`cannot project missing session ${event.sessionId}`);
      await transaction.query(
        `INSERT INTO ${this.table('ownerEventCounters')} (owner_id, n) VALUES ($1, 0)
         ON CONFLICT (owner_id) DO NOTHING`,
        [session.owner_id],
      );
      const allocated = await transaction.query<{ n: bigint | string }>(
        `UPDATE ${this.table('ownerEventCounters')} SET n = n + 1
         WHERE owner_id = $1 RETURNING n`,
        [session.owner_id],
      );
      const counter = allocated.rows[0];
      if (!counter) throw new Error(`cannot allocate owner event id for ${session.owner_id}`);
      const status = 'status' in event ? event.status : null;
      const attempt = 'attempt' in event ? event.attempt : null;
      const data = {};
      await transaction.query(
        `INSERT INTO ${this.table('ownerEvents')}
          (owner_id, id, ts, session_id, type, status, attempt, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          session.owner_id,
          String(counter.n),
          event.ts,
          event.sessionId,
          event.type,
          status,
          attempt,
          encodeJson(data, 'owner event data'),
        ],
      );
      // Stays inside the projection SAVEPOINT (reference semantics): a queued
      // NOTIFY is emitted only when the outer mutation commits, and a failed
      // projection rolls it back with the owner row.
      await this.ownerEventHook?.(transaction, {
        ...event,
        id: String(counter.n),
        ownerId: session.owner_id,
      });
      await transaction.query(`RELEASE SAVEPOINT ${savepoint}`);
      return BigInt(counter.n);
    } catch (error) {
      try {
        await transaction.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await transaction.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // The outer transaction may already be unusable; preserve the projection error for logging.
      }
      this.logger.error(
        'owner session projection failed; committing business mutation for full-list reconciliation',
        { type: event.type, sessionId: event.sessionId },
        error,
      );
      return null;
    }
  }

  async readAfter(
    ownerId: string,
    afterId: bigint,
    limit = 500,
  ): Promise<PersistedOwnerSessionEvent[]> {
    const result = await this.queryable.query<{
      owner_id: string;
      id: bigint | string;
      ts: number | string;
      session_id: string;
      type: PersistedOwnerSessionEvent['type'];
      status: AgentSessionMeta['status'] | null;
      attempt: number | null;
      data: unknown;
    }>(
      `SELECT owner_id, id, ts, session_id, type, status, attempt, data
       FROM ${this.table('ownerEvents')}
       WHERE owner_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [ownerId, afterId.toString(), limit],
    );
    return result.rows.map((row) => {
      const base = {
        id: String(row.id),
        ownerId: row.owner_id,
        sessionId: row.session_id,
        ts: Number(row.ts),
      };
      if (row.type === 'session_created' || row.type === 'session_status') {
        return {
          ...base,
          type: row.type,
          status: row.status!,
          attempt: Number(row.attempt ?? 0),
        };
      }
      return { ...base, type: row.type } as PersistedOwnerSessionEvent;
    });
  }

  async readMaxId(ownerId: string): Promise<bigint> {
    const result = await this.queryable.query<{ n: bigint | string }>(
      `SELECT n FROM ${this.table('ownerEventCounters')} WHERE owner_id = $1`,
      [ownerId],
    );
    return BigInt(result.rows[0]?.n ?? 0);
  }

  async readRetirement(ownerId: string): Promise<string | null> {
    // The host resolver runs inside a transaction because the hook contract
    // assumes transactional execution (its advisory locks are transaction-
    // scoped); running it on the shared queryable would release those locks
    // before the resolver's read. The read itself takes no row locks beyond
    // what the resolver chooses to take.
    return this.transaction(async (tx) => {
      const finalOwner = await this.resolveOwnerHook(tx, ownerId);
      return finalOwner === ownerId ? null : finalOwner;
    });
  }

  async mergeOwner(fromOwnerId: string, toOwnerId: string): Promise<number> {
    if (fromOwnerId === toOwnerId) return 0;
    return this.transaction(async (tx) => {
      const finalTarget = await this.resolveOwnerHook(tx, toOwnerId);
      // The literal guard above only catches the same-string case. A resolver
      // that collapses the target back onto the source (a merge chain that
      // already collapsed) must also be a no-op: proceeding would re-key
      // sessions to themselves and renumber the owner's own projection above
      // its high-water mark.
      if (fromOwnerId === finalTarget) return 0;
      const locked = await tx.query<{ id: string; owner_id: string }>(
        `SELECT id, owner_id FROM ${this.table('sessions')}
         WHERE owner_id IN ($1, $2) ORDER BY id FOR UPDATE`,
        [fromOwnerId, finalTarget],
      );
      const sourceIds = new Set(
        locked.rows.filter((row) => row.owner_id === fromOwnerId).map((row) => row.id),
      );
      if (sourceIds.size > 0) {
        await tx.query(
          `UPDATE ${this.table('sessions')} SET owner_id = $2, updated_at = now()
           WHERE owner_id = $1`,
          [fromOwnerId, finalTarget],
        );
      }
      const savepoint = `agent_session_merge_projection_${(savepointSerial += 1)}`;
      try {
        await tx.query(`SAVEPOINT ${savepoint}`);
        const owners = [fromOwnerId, finalTarget].sort();
        for (const ownerId of owners) {
          await tx.query(
            `INSERT INTO ${this.table('ownerEventCounters')} (owner_id, n) VALUES ($1, 0)
             ON CONFLICT (owner_id) DO NOTHING`,
            [ownerId],
          );
          await tx.query(
            `SELECT n FROM ${this.table('ownerEventCounters')} WHERE owner_id = $1 FOR UPDATE`,
            [ownerId],
          );
        }
        await tx.query(
          `WITH bounds AS (
             SELECT greatest(
               coalesce((SELECT max(n) FROM ${this.table('ownerEventCounters')}
                         WHERE owner_id IN ($1, $2)), 0),
               coalesce((SELECT max(id) FROM ${this.table('ownerEvents')}
                         WHERE owner_id IN ($1, $2)), 0)
             ) AS high
           ), source_events AS MATERIALIZED (
             SELECT e.*, row_number() OVER (ORDER BY e.id, e.ts, e.session_id) AS ordinal
             FROM ${this.table('ownerEvents')} e WHERE e.owner_id = $1
           )
           INSERT INTO ${this.table('ownerEvents')}
             (owner_id, id, ts, session_id, type, status, attempt, data)
           SELECT $2, bounds.high + source_events.ordinal, source_events.ts,
                  source_events.session_id, source_events.type, source_events.status,
                  source_events.attempt, source_events.data
           FROM source_events CROSS JOIN bounds`,
          [fromOwnerId, finalTarget],
        );
        await tx.query(`DELETE FROM ${this.table('ownerEvents')} WHERE owner_id = $1`, [
          fromOwnerId,
        ]);
        await tx.query(
          `UPDATE ${this.table('ownerEventCounters')}
           SET n = greatest(n, coalesce((SELECT max(id) FROM ${this.table('ownerEvents')}
                                        WHERE owner_id = $1), 0))
           WHERE owner_id = $1`,
          [finalTarget],
        );
        await tx.query(`DELETE FROM ${this.table('ownerEventCounters')} WHERE owner_id = $1`, [
          fromOwnerId,
        ]);
        await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (error) {
        try {
          await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // Preserve the package-owned business merge when only its projection is damaged.
        }
        this.logger.error(
          'owner session projection merge failed; committing session ownership changes',
          { fromOwnerId, toOwnerId: finalTarget },
          error,
        );
      }
      return sourceIds.size;
    });
  }
}

class PgAgentSessionEntryTreeHandle implements AgentSessionEntryTreeHandle {
  private readonly entries: AgentSessionEntry[];
  private readonly byId: Map<string, AgentSessionEntry>;
  private readonly labelsById = new Map<string, string>();
  private currentLeafId: string | null = null;

  /** Reference `leafIdAfterEntry`: a leaf target is the leaf id, verbatim. */
  private static leafIdAfter(entry: AgentSessionEntry): string | null {
    if (entry.type !== 'leaf') return entry.id;
    // An empty-string target is preserved as '' instead of collapsing to null;
    // only a missing (malformed) target normalizes to null.
    return (entry.targetId as string | null | undefined) ?? null;
  }

  constructor(
    private readonly store: PgAgentSessionStore,
    private readonly sessionId: string,
    private readonly workerId: string,
    private readonly attempt: number,
    entries: AgentSessionEntry[],
  ) {
    this.entries = entries;
    this.byId = new Map();
    for (const entry of entries) {
      if (this.byId.has(entry.id)) {
        throw new AgentSessionEntryTreeError(sessionId, `duplicate entry id ${entry.id}`);
      }
      if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
        throw new AgentSessionEntryTreeError(sessionId, `missing parent ${entry.parentId}`);
      }
      this.byId.set(entry.id, entry);
      this.updateLabel(entry);
      this.currentLeafId = PgAgentSessionEntryTreeHandle.leafIdAfter(entry);
    }
  }

  private updateLabel(entry: AgentSessionEntry): void {
    if (entry.type !== 'label') return;
    const targetId = String(entry.targetId ?? '');
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (label) this.labelsById.set(targetId, label);
    else this.labelsById.delete(targetId);
  }

  async getEntries(): Promise<AgentSessionEntry[]> {
    return [...this.entries];
  }

  async getEntry(id: string): Promise<AgentSessionEntry | undefined> {
    return this.byId.get(id);
  }

  async findEntries<TType extends AgentSessionEntry['type']>(
    type: TType,
  ): Promise<Array<Extract<AgentSessionEntry, { type: TType }>>> {
    return this.entries.filter(
      (entry): entry is Extract<AgentSessionEntry, { type: TType }> => entry.type === type,
    );
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.labelsById.get(id);
  }

  async getPathToRoot(leafId: string | null): Promise<AgentSessionEntry[]> {
    if (leafId === null) return [];
    const path: AgentSessionEntry[] = [];
    let current = this.byId.get(leafId);
    if (!current) throw new AgentSessionEntryTreeError(this.sessionId, `missing entry ${leafId}`);
    while (current) {
      path.unshift(current);
      if (current.parentId === null) break;
      const parent = this.byId.get(current.parentId);
      if (!parent) {
        throw new AgentSessionEntryTreeError(this.sessionId, `missing parent ${current.parentId}`);
      }
      current = parent;
    }
    return path;
  }

  async getLeafId(): Promise<string | null> {
    if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
      throw new AgentSessionEntryTreeError(this.sessionId, `missing leaf ${this.currentLeafId}`);
    }
    return this.currentLeafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new AgentSessionEntryTreeError(this.sessionId, `missing entry ${leafId}`);
    }
    await this.appendEntry({
      id: await this.createEntryId(),
      parentId: this.currentLeafId,
      type: 'leaf',
      timestamp: new Date().toISOString(),
      targetId: leafId,
    });
  }

  async appendEntry(entry: AgentSessionEntry): Promise<void> {
    if (this.byId.has(entry.id)) {
      throw new AgentSessionEntryTreeError(this.sessionId, `duplicate entry id ${entry.id}`);
    }
    if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
      throw new AgentSessionEntryTreeError(this.sessionId, `missing parent ${entry.parentId}`);
    }
    await this.store.appendTreeEntry(this.sessionId, this.workerId, this.attempt, entry);
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.updateLabel(entry);
    this.currentLeafId = PgAgentSessionEntryTreeHandle.leafIdAfter(entry);
  }

  async createEntryId(): Promise<string> {
    for (let index = 0; index < 100; index += 1) {
      const id = randomUUID().slice(0, 8);
      if (!this.byId.has(id)) return id;
    }
    return randomUUID();
  }
}
