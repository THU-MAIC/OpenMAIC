/**
 * Runtime data of a deleted course is gone from the product's point of view.
 *
 * Deleting a course tombstones it (`stage_meta.deleted_at`) and keeps its rows,
 * and runtime sessions carry only a stage id, so nothing in the runtime store
 * knows about the tombstone. This guard is the app's composition of the two:
 * a session whose course is tombstoned reads as absent, its stage lists no
 * sessions, and — because the HTTP handler reads a session before every write
 * to it — status changes and record appends answer 404 as for an unknown
 * session. Creating a session on a tombstoned course is refused by the route
 * before the handler runs (`runtimeSessionCreateStageId`), since the handler
 * would otherwise classify a store refusal as an internal error.
 *
 * A course without `stage_meta` (never stored on this server) is not
 * tombstoned: runtime for local-only courses keeps working.
 *
 * Deleting one's own runtime for a stage (`deleteLearnerRuntime`) is left
 * through: removing data of a deleted course is what a user would want.
 */
import type { RuntimeSession } from '@openmaic/dsl';
import type { RuntimeStore } from '@openmaic/storage';

export type StageTombstoneReader = (stageId: string) => Promise<boolean>;

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Whether PostgreSQL can bind the id; one it cannot bind names no row. */
export function isQueryableStageId(stageId: string): boolean {
  return stageId !== '' && !stageId.includes('\0') && !LONE_SURROGATE.test(stageId);
}

export function createTombstoneGuardedRuntimeStore(
  inner: RuntimeStore,
  isTombstoned: StageTombstoneReader,
): RuntimeStore {
  const tombstoned = (stageId: string) =>
    isQueryableStageId(stageId) ? isTombstoned(stageId) : Promise.resolve(false);
  return {
    createSession: (init) => inner.createSession(init),
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

/**
 * The stage id a `POST /runtime/sessions` request would create a session on,
 * read from a clone of the request so the handler still receives the body.
 * `undefined` for any other request, and for a body the handler will reject
 * as malformed anyway.
 */
export async function runtimeSessionCreateStageId(
  request: Request,
  path: string,
): Promise<string | undefined> {
  if (request.method !== 'POST' || path !== '/runtime/sessions') return undefined;
  try {
    const body = (await request.clone().json()) as { stageId?: unknown } | null;
    return typeof body?.stageId === 'string' ? body.stageId : undefined;
  } catch {
    return undefined;
  }
}
