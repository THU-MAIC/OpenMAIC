/**
 * Browser {@link RuntimeStore} backend: runtime sessions + append-only records
 * across two IndexedDB object stores (`sessions` / `records`). Writes stamp the
 * runtime version, validate the full envelope, and gate record payloads through
 * the per-kind validators (the DSL skeleton guards by default, or an injected
 * map for app-defined kinds); reads migrate sessions forward on the runtime
 * line. Matches the document backend's idiom — an injectable `IDBFactory`, a
 * memoized open that clears on failure, and transactions that resolve on commit
 * (not on the request) so a write claims durability only once the store
 * actually kept it.
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

const SESSIONS = 'sessions';
const RECORDS = 'records';
const SESSIONS_BY_STAGE_LEARNER = 'by-stage-learner';
const SESSIONS_BY_LEARNER = 'by-learner';
const SESSIONS_BY_STAGE = 'by-stage';

/**
 * Default per-kind payload gate: the DSL skeletons for the skeleton kinds.
 * Kinds without an entry (`playback`, app-defined kinds) take app-owned
 * payloads the store does not inspect.
 */
const DEFAULT_PAYLOAD_VALIDATORS: Record<string, RuntimePayloadValidator> = {
  chat: (p) =>
    isChatMessageSkeleton(p)
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
  quizAttempt: (p) =>
    isQuizAttemptSkeleton(p)
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

export interface BrowserRuntimeStoreOptions {
  /** IndexedDB factory. Defaults to the ambient `indexedDB`. Injectable for tests. */
  indexedDB?: IDBFactory;
  /** Database name. Defaults to `maic-runtime`. */
  dbName?: string;
  /**
   * Per-kind payload validators run at the append boundary, keyed by
   * `RuntimeSession.kind`. REPLACES the default map (the DSL skeleton guards
   * for `chat` / `quizAttempt`), so an app that widens a skeleton kind's
   * payload — or wants no gate at all — takes full ownership of the mapping
   * rather than fighting a merged default.
   */
  payloadValidators?: Record<string, RuntimePayloadValidator>;
}

/** Promisify a single IndexedDB request. */
function reqP<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Throw a fail-loud error listing every validation issue, or pass. */
function assertValid(result: ReturnType<typeof validateRuntimeSession>, label: string): void {
  if (result.valid) return;
  const detail = result.errors.map((e) => `${e.path || '/'}: ${e.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

/**
 * True when a stored session row is stamped *ahead* of this client's
 * `RUNTIME_DSL_VERSION` (`needsRuntimeMigration` false means version >=
 * current; a version that is also not equal to current is strictly greater).
 * Such data was written by a newer client; an older client must not mutate it
 * (see the write guards). A non-object carries no version claim, so it is
 * never "future". Only ever called on rows read from the store — which this
 * backend always stamps — so the runtime-line readers' fail-loud throw on an
 * unstamped or sibling-stamped object propagates as a corruption error rather
 * than being swallowed.
 */
function isFutureRuntimeVersioned(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  return !needsRuntimeMigration(row) && runtimeDslVersionOf(row) !== RUNTIME_DSL_VERSION;
}

/** The shared write-guard error for a session written by a newer client. */
function futureSessionError(sessionId: string, row: RuntimeSession): Error {
  return new Error(
    `@openmaic/storage: session ${JSON.stringify(sessionId)} was written at runtime DSL ` +
      `version ${JSON.stringify(runtimeDslVersionOf(row))}, newer than this client's ` +
      `${RUNTIME_DSL_VERSION}`,
  );
}

/**
 * Migrate a session row forward on the runtime line. Future-stamped rows pass
 * through unchanged — a read never downgrades, mirroring `loadDocument`.
 */
function migrateSession(row: RuntimeSession): RuntimeSession {
  return needsRuntimeMigration(row) ? (migrateRuntime(row) as RuntimeSession) : row;
}

/** Every record of one session: `seq` spans `[0, Infinity)` under its id. */
function sessionRecordRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
}

export class BrowserRuntimeStore implements RuntimeStore {
  private readonly idb: IDBFactory;
  private readonly dbName: string;
  private readonly payloadValidators: Record<string, RuntimePayloadValidator>;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(options: BrowserRuntimeStoreOptions = {}) {
    this.idb = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName ?? 'maic-runtime';
    this.payloadValidators = options.payloadValidators ?? DEFAULT_PAYLOAD_VALIDATORS;
  }

  private openDb(): Promise<IDBDatabase> {
    // Do NOT cache a rejected open: a transient failure (private-mode IDB, a
    // one-off VersionError) would otherwise brick the store for the session.
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSIONS)) {
          const sessions = db.createObjectStore(SESSIONS, { keyPath: 'id' });
          // The partition key of the runtime layer: every list/delete query is
          // scoped to one learner on one stage (or one whole dimension of it).
          sessions.createIndex(SESSIONS_BY_STAGE_LEARNER, ['stageId', 'learnerKey'], {
            unique: false,
          });
          sessions.createIndex(SESSIONS_BY_LEARNER, 'learnerKey', { unique: false });
          sessions.createIndex(SESSIONS_BY_STAGE, 'stageId', { unique: false });
        }
        if (!db.objectStoreNames.contains(RECORDS)) {
          // Compound key so record ordering IS the primary-key ordering: a
          // ranged read over one session comes back sorted by `seq` for free.
          db.createObjectStore(RECORDS, { keyPath: ['sessionId', 'seq'] });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      this.dbPromise = undefined;
      throw err;
    });
    return this.dbPromise;
  }

  /**
   * Run `body` inside one transaction, resolving with its return value on
   * commit. A throw from `body` aborts the transaction and rejects with that
   * error, so a failed multi-write leaves the stores untouched (atomicity).
   */
  private async txRun<T>(
    stores: string[],
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(failure ?? tx.error);
      tx.onabort = () => reject(failure ?? tx.error);
      void (async () => {
        try {
          result = await body(tx);
        } catch (err) {
          failure = err;
          // The transaction may already be finishing; ignore a late abort throw.
          try {
            tx.abort();
          } catch {
            /* already inactive */
          }
        }
      })();
    });
  }

  /** The payload gate for `kind`, if one is configured (own keys only). */
  private validatorFor(kind: string): RuntimePayloadValidator | undefined {
    return Object.hasOwn(this.payloadValidators, kind) ? this.payloadValidators[kind] : undefined;
  }

  async createSession(init: RuntimeSessionInit): Promise<RuntimeSession> {
    // The store owns the version stamp: sessions are born stamped, and the
    // completed envelope is validated BEFORE the transaction opens, so an
    // invalid session fails loud without any write.
    const stamped: RuntimeSession = { ...init, runtimeDslVersion: RUNTIME_DSL_VERSION };
    assertValid(validateRuntimeSession(stamped), `runtime session ${JSON.stringify(stamped.id)}`);

    await this.txRun([SESSIONS], 'readwrite', async (tx) => {
      const sessions = tx.objectStore(SESSIONS);
      // Creating twice is a caller bug, not an upsert. Check inside the write
      // transaction (no TOCTOU) for a deterministic error; `add` (not `put`)
      // stays as the safety net so a race can never silently overwrite.
      const existing = await reqP<RuntimeSession | undefined>(sessions.get(stamped.id));
      if (existing !== undefined) {
        throw new Error(`@openmaic/storage: session ${JSON.stringify(stamped.id)} already exists`);
      }
      sessions.add(stamped);
    });
    return stamped;
  }

  async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
    const row = await this.txRun([SESSIONS], 'readonly', (tx) =>
      reqP<RuntimeSession | undefined>(tx.objectStore(SESSIONS).get(sessionId)),
    );
    if (row === undefined) return undefined;
    const session = migrateSession(row);
    // A read gates the stored row through the same envelope validation as the
    // writes: a row whose stamp resolves but whose other fields are corrupt is
    // a stored-row integrity failure, and a direct read fails loud rather than
    // hand the caller a session the store itself would refuse to write.
    assertValid(
      validateRuntimeSession(session),
      `stored runtime session ${JSON.stringify(sessionId)}`,
    );
    return session;
  }

  async listSessions(stageId: string, learnerKey: string): Promise<RuntimeSession[]> {
    const rows = await this.txRun([SESSIONS], 'readonly', (tx) =>
      reqP<RuntimeSession[]>(
        tx.objectStore(SESSIONS).index(SESSIONS_BY_STAGE_LEARNER).getAll([stageId, learnerKey]),
      ),
    );
    // Listings tolerate corrupt rows — version OR envelope corruption — by
    // omission (the `listDocuments` precedent): one poison row must not make
    // the whole partition unenumerable. A direct `getSession` on such an id
    // stays fail-loud, and the delete paths remain the cleanup tool.
    const sessions: RuntimeSession[] = [];
    for (const row of rows) {
      try {
        const session = migrateSession(row);
        assertValid(
          validateRuntimeSession(session),
          `stored runtime session ${JSON.stringify(session.id)}`,
        );
        sessions.push(session);
      } catch {
        // omitted: this row's version resolution or envelope validation failed
      }
    }
    // Order by the instant each timestamp denotes, not by the string: ISO-8601
    // permits numeric zone offsets, and string order disagrees with instant
    // order across offsets. `Date.parse` is safe here — both strings already
    // passed `isIsoTimestamp` at write time. Tie-break on `id` for a
    // deterministic listing.
    return sessions.sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async setSessionStatus(
    sessionId: string,
    status: RuntimeSessionStatus,
    updatedAt: string,
  ): Promise<void> {
    await this.txRun([SESSIONS], 'readwrite', async (tx) => {
      const sessions = tx.objectStore(SESSIONS);
      const row = await reqP<RuntimeSession | undefined>(sessions.get(sessionId));
      if (!row) {
        throw new Error(`@openmaic/storage: no session ${JSON.stringify(sessionId)}`);
      }
      // Forward-compatibility: never mutate (and thereby downgrade) a session
      // written by a newer client.
      if (isFutureRuntimeVersioned(row)) throw futureSessionError(sessionId, row);
      // A stale row is migrated in place before the write. Unlike `putScene`
      // there is nothing to strand: records carry no version of their own, and
      // this interface has no full-session save for a caller-side remedy.
      const updated: RuntimeSession = { ...migrateSession(row), status, updatedAt };
      assertValid(validateRuntimeSession(updated), `runtime session ${JSON.stringify(sessionId)}`);
      sessions.put(updated);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Idempotent and deliberately version-agnostic: removal is a coarse,
    // deliberate action regardless of the version the data was written at.
    await this.txRun([SESSIONS, RECORDS], 'readwrite', (tx) => {
      tx.objectStore(SESSIONS).delete(sessionId);
      tx.objectStore(RECORDS).delete(sessionRecordRange(sessionId));
    });
  }

  async appendRecord<TPayload extends RuntimePayload>(
    init: RuntimeRecordInit<TPayload>,
  ): Promise<RuntimeRecord<TPayload>> {
    // Pre-flight the envelope BEFORE opening the write transaction. `seq` is
    // store-assigned, so validate with a placeholder the in-tx value replaces —
    // every other field is exactly what will be persisted.
    assertValid(
      validateRuntimeRecord({ ...init, seq: 0 }),
      `runtime record ${JSON.stringify(init.id)}`,
    );

    return this.txRun([SESSIONS, RECORDS], 'readwrite', async (tx) => {
      const sessions = tx.objectStore(SESSIONS);
      const row = await reqP<RuntimeSession | undefined>(sessions.get(init.sessionId));
      if (!row) {
        throw new Error(`@openmaic/storage: no session ${JSON.stringify(init.sessionId)}`);
      }
      if (isFutureRuntimeVersioned(row)) throw futureSessionError(init.sessionId, row);
      // Migrate a stale parent in place inside the same transaction, so the
      // stored session and the record appended under it land together.
      let session = row;
      if (needsRuntimeMigration(row)) {
        session = migrateSession(row);
        sessions.put(session);
      }
      if (session.status !== 'active') {
        throw new Error(
          `@openmaic/storage: cannot append to session ${JSON.stringify(init.sessionId)} with ` +
            `status '${session.status}' — records may only be appended to an active session`,
        );
      }
      // The payload gate keys on the parent's kind (after migration).
      const validator = this.validatorFor(session.kind);
      if (validator) {
        assertValid(validator(init.payload), `runtime record ${JSON.stringify(init.id)}`);
      }

      // Assign the per-session monotonic `seq` inside the same transaction that
      // inserts: the highest existing key in the session's range, plus one. A
      // key cursor reads only the compound primary key — deserializing the
      // whole previous record (payload included) to read one integer would be
      // O(payload) for no benefit.
      const records = tx.objectStore(RECORDS);
      const last = await reqP(records.openKeyCursor(sessionRecordRange(init.sessionId), 'prev'));
      const seq = last ? (last.primaryKey as [string, number])[1] + 1 : 0;
      const record: RuntimeRecord<TPayload> = { ...init, seq };
      // The pre-flight above fails before the transaction opens (no write
      // started); this assert on the REAL record — with the store-assigned
      // `seq` — makes the "validates the completed envelope" contract
      // literally true. validateRuntimeRecord is pure and synchronous, so the
      // transaction cannot idle out here.
      assertValid(validateRuntimeRecord(record), `runtime record ${JSON.stringify(init.id)}`);
      records.add(record);
      return record;
    });
  }

  async listRecords(sessionId: string, opts?: { sceneId?: string }): Promise<RuntimeRecord[]> {
    // The compound primary key ['sessionId', 'seq'] makes a ranged read come
    // back already ordered by `seq`. An absent session simply owns no range.
    const rows = await this.txRun([RECORDS], 'readonly', (tx) =>
      reqP<RuntimeRecord[]>(tx.objectStore(RECORDS).getAll(sessionRecordRange(sessionId))),
    );
    const sceneId = opts?.sceneId;
    // Anchors are best-effort: the filter narrows to records anchored to that
    // scene, excluding un-anchored ones.
    return sceneId === undefined ? rows : rows.filter((r) => r.sceneId === sceneId);
  }

  async mergeLearner(fromLearnerKey: string, toLearnerKey: string): Promise<number> {
    // Global re-key (across ALL stages) — the anonymous-learner-signs-in
    // migration, and the one deliberate cross-stage sweep in the interface.
    // Sessions are keyed by their own id, so the move is non-clobbering by
    // construction; records reference sessions by id and are untouched.
    //
    // A merge is a write, so it takes the same gates as every other write: a
    // learner key `createSession` would reject must not be written here, a
    // newer client's session must not be mutated, and every re-keyed envelope
    // is validated before it is put. Any throw aborts the WHOLE merge
    // atomically (txRun) — loud and clean beats silently contaminating the
    // target partition with poison rows; `deleteSession` on the offending id
    // is the unblock.
    if (
      typeof fromLearnerKey !== 'string' ||
      fromLearnerKey === '' ||
      typeof toLearnerKey !== 'string' ||
      toLearnerKey === ''
    ) {
      throw new Error('@openmaic/storage: learner keys must be non-empty strings');
    }
    // Self-merge: nothing to move — return without opening a transaction, so
    // "a second run moves 0" holds for the degenerate case too (re-keying
    // x → x would otherwise count every row, every time).
    if (fromLearnerKey === toLearnerKey) return 0;
    return this.txRun([SESSIONS], 'readwrite', async (tx) => {
      const sessions = tx.objectStore(SESSIONS);
      const rows = await reqP<RuntimeSession[]>(
        sessions.index(SESSIONS_BY_LEARNER).getAll(fromLearnerKey),
      );
      for (const row of rows) {
        // Re-keying is a mutation; a future-stamped session was written by a
        // newer client and must not be touched. A corrupt stamp (absent /
        // malformed / sibling-stamped) throws the runtime line's own error
        // from inside the guard and aborts the merge the same way.
        if (isFutureRuntimeVersioned(row)) throw futureSessionError(row.id, row);
        // Migrate a stale row in place before mutating it — the same
        // migrate-in-place semantics as setSessionStatus/appendRecord — so a
        // merge never writes an old stamp into the target partition.
        const updated: RuntimeSession = { ...migrateSession(row), learnerKey: toLearnerKey };
        assertValid(validateRuntimeSession(updated), `runtime session ${JSON.stringify(row.id)}`);
        sessions.put(updated);
      }
      return rows.length;
    });
  }

  async deleteLearnerRuntime(stageId: string, learnerKey: string): Promise<void> {
    await this.deleteSessionsByIndex(SESSIONS_BY_STAGE_LEARNER, [stageId, learnerKey]);
  }

  async deleteStageRuntime(stageId: string): Promise<void> {
    await this.deleteSessionsByIndex(SESSIONS_BY_STAGE, stageId);
  }

  /**
   * Cascade-delete every session matched by an index query, plus each
   * session's record range. Idempotent (nothing matched, nothing deleted) and
   * deliberately version-agnostic, like `deleteDocument`.
   */
  private async deleteSessionsByIndex(indexName: string, query: IDBValidKey): Promise<void> {
    await this.txRun([SESSIONS, RECORDS], 'readwrite', async (tx) => {
      const sessions = tx.objectStore(SESSIONS);
      const records = tx.objectStore(RECORDS);
      const ids = await reqP<IDBValidKey[]>(sessions.index(indexName).getAllKeys(query));
      for (const id of ids) {
        sessions.delete(id);
        records.delete(sessionRecordRange(id as string));
      }
    });
  }
}
