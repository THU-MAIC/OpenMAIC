/**
 * Runtime data of a deleted course is gone from the product's point of view.
 *
 * Deleting a course tombstones it (`stage_meta.deleted_at`) and keeps its rows,
 * and runtime sessions carry only a stage id, so nothing in the runtime store
 * knows about the tombstone. This guard is the app's composition of the two:
 * a session whose course is tombstoned reads as absent, its stage lists no
 * sessions, and — because the HTTP handler reads a session before every write
 * to it — status changes and record appends answer 404 as for an unknown
 * session. Creating a session on a tombstoned course is refused by the store
 * itself with `RuntimeStageNotFoundError`, which the handler answers with
 * `404 STAGE_NOT_FOUND`. Refusing it here, below the router, means no spelling
 * of the request path can route around it.
 *
 * A course without `stage_meta` (never stored on this server) is not
 * tombstoned: runtime for local-only courses keeps working.
 *
 * Deleting one's own runtime for a stage (`deleteLearnerRuntime`) is left
 * through: removing data of a deleted course is what a user would want.
 */
import type { RuntimeSession } from '@openmaic/dsl';
import { RuntimeStageNotFoundError, type RuntimeStore } from '@openmaic/storage';

import { readStageMeta } from './stage-meta';

export type StageTombstoneReader = (stageId: string) => Promise<boolean>;

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Whether PostgreSQL can bind the id; one it cannot bind names no row. */
export function isQueryableStageId(stageId: string): boolean {
  return stageId !== '' && !stageId.includes('\0') && !LONE_SURROGATE.test(stageId);
}

/** Whether `stageId` names a course this server stored and then tombstoned. */
export async function isStageTombstoned(
  queryable: Parameters<typeof readStageMeta>[0],
  stageId: string,
): Promise<boolean> {
  if (!isQueryableStageId(stageId)) return false;
  const meta = await readStageMeta(queryable, stageId);
  return meta !== null && meta.deletedAt !== null;
}

/**
 * The server's runtime store for every server-side writer: the persistence
 * route and the Pi native whiteboard alike. No server path should hold the
 * unguarded store.
 */
export function guardedServerRuntimeStore(
  inner: RuntimeStore,
  queryable: Parameters<typeof readStageMeta>[0],
): RuntimeStore {
  return createTombstoneGuardedRuntimeStore(inner, (stageId) =>
    isStageTombstoned(queryable, stageId),
  );
}

export function createTombstoneGuardedRuntimeStore(
  inner: RuntimeStore,
  isTombstoned: StageTombstoneReader,
): RuntimeStore {
  const tombstoned = (stageId: string) =>
    isQueryableStageId(stageId) ? isTombstoned(stageId) : Promise.resolve(false);
  return {
    async createSession(init) {
      if (await tombstoned(init.stageId)) throw new RuntimeStageNotFoundError(init.stageId);
      return inner.createSession(init);
    },
    async getSession(sessionId: string): Promise<RuntimeSession | undefined> {
      const session = await inner.getSession(sessionId);
      if (session === undefined) return undefined;
      return (await tombstoned(session.stageId)) ? undefined : session;
    },
    async listSessions(stageId, learnerKey) {
      if (await tombstoned(stageId)) return [];
      return inner.listSessions(stageId, learnerKey);
    },
    setSessionStatus: (sessionId, status, updatedAt, options) =>
      inner.setSessionStatus(sessionId, status, updatedAt, options),
    deleteSession: (sessionId) => inner.deleteSession(sessionId),
    appendRecord: (init, options) => inner.appendRecord(init, options),
    listRecords: (sessionId, opts) => inner.listRecords(sessionId, opts),
    mergeLearner: (from, to) => inner.mergeLearner(from, to),
    deleteLearnerRuntime: (stageId, learnerKey) => inner.deleteLearnerRuntime(stageId, learnerKey),
    deleteStageRuntime: (stageId) => inner.deleteStageRuntime(stageId),
    deleteAllRuntime: () => inner.deleteAllRuntime(),
  };
}
