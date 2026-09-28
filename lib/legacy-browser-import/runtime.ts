/**
 * Learner runtime (chat, quiz attempts, whiteboard, PBL) from the browser
 * runtime store, copied into the server runtime store for the server-derived
 * learner key.
 *
 * The browser store partitioned sessions by a device learner key; the server
 * partitions by the owner id. Sessions are copied as they are -- id, kind,
 * timestamps, records in order, final status -- with the learner key replaced,
 * which is exactly what the runtime contract's learner merge does to a session
 * (ids are immutable; readers select by the `learnerKey` field). A course
 * imported under a fresh id also has its id segment carried over in session
 * and record ids, because the chat layer finds a session by that prefix.
 *
 * Resumable: the ledger records a session's server id before it is created,
 * so after a crash the importer recognizes its own half-copied session and
 * appends only the records the server does not have yet (records carry a
 * store-assigned `seq`, so the server's count is where to continue). A session
 * that exists on the server but is not in the ledger was written by the app
 * itself; the server copy wins and the legacy one is not copied.
 */
import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import type { RuntimeStore } from '@openmaic/storage';

import { failureOrStop } from './errors';
import { rewriteStageSegment } from './ids';
import type { CourseEntry } from './ledger';
import type { LegacyRuntimeReader } from '@/lib/legacy-browser-storage';

export interface RuntimeCopyContext {
  readonly legacy: LegacyRuntimeReader;
  readonly legacyLearnerKey: string;
  readonly server: RuntimeStore;
  readonly learnerKey: string;
  /** The course id the legacy sessions are filed under. */
  readonly legacyStageId: string;
  /** The course id on the server. */
  readonly stageId: string;
  readonly entry: CourseEntry;
  readonly checkpoint: () => void;
  readonly log: (message: string, ...details: unknown[]) => void;
}

/** Kinds of which the app keeps a single active session per learner and course. */
const SINGLE_ACTIVE_KINDS: ReadonlySet<string> = new Set(['whiteboard', 'pbl']);

/** Payload fields that name other runtime sessions (chat restore markers). */
function rewritePayload(payload: unknown, from: string, to: string): unknown {
  if (from === to || typeof payload !== 'object' || payload === null) return payload;
  const candidate = payload as { runtimeSessionIds?: unknown };
  if (!Array.isArray(candidate.runtimeSessionIds)) return payload;
  return {
    ...candidate,
    runtimeSessionIds: candidate.runtimeSessionIds.map((id) =>
      typeof id === 'string' ? rewriteStageSegment(id, from, to) : id,
    ),
  };
}

function recordInit(record: RuntimeRecord, sessionId: string, from: string, to: string) {
  return {
    id: rewriteStageSegment(record.id, from, to),
    sessionId,
    createdAt: record.createdAt,
    payload: rewritePayload(record.payload, from, to) as RuntimeRecord['payload'],
    ...(record.sceneId === undefined ? {} : { sceneId: record.sceneId }),
    ...(record.actionIndex === undefined ? {} : { actionIndex: record.actionIndex }),
    ...(record.subAnchor === undefined ? {} : { subAnchor: record.subAnchor }),
  };
}

/** Whether the session could not be copied as-is (it is skipped; the rest continue). */
type SessionOutcome = 'copied' | 'kept-server' | 'skipped';

async function copySession(
  session: RuntimeSession,
  context: RuntimeCopyContext,
): Promise<SessionOutcome> {
  const { entry, server, legacyStageId, stageId } = context;
  const sessions = (entry.sessions ??= {});
  const targetId = rewriteStageSegment(session.id, legacyStageId, stageId);
  const ours = sessions[session.id] === targetId;

  let existing = await server.getSession(targetId);
  if (existing && !ours) return 'kept-server';
  if (!existing && session.status === 'active' && SINGLE_ACTIVE_KINDS.has(session.kind)) {
    // The app keeps one active session of these kinds per learner and course,
    // and a whiteboard read refuses two ("ambiguous"). One the learner already
    // started on the server (after the course arrived, before this retry)
    // wins; the legacy one stays in the browser.
    const active = (await server.listSessions(stageId, context.learnerKey)).some(
      (candidate) =>
        candidate.kind === session.kind &&
        candidate.status === 'active' &&
        candidate.id !== targetId,
    );
    if (active) {
      context.log(`Runtime session ${session.id} was not imported: the server has an active one`);
      return 'kept-server';
    }
  }
  if (!existing) {
    // Recorded before the create: a crash after the create must still find
    // this session to be the importer's own.
    sessions[session.id] = targetId;
    context.checkpoint();
    try {
      existing = await server.createSession({
        id: targetId,
        kind: session.kind,
        stageId,
        learnerKey: context.learnerKey,
        // Created active so the records can be appended; the final status is
        // set once they are.
        status: 'active',
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    } catch (error) {
      const raced = await server.getSession(targetId).catch(() => undefined);
      if (!raced) {
        // Taken, yet not readable: another learner holds this session id.
        if ((error as { code?: unknown } | null)?.code === 'SESSION_ALREADY_EXISTS') {
          context.log(`Runtime session ${session.id} was not imported: its id is taken`);
          return 'skipped';
        }
        throw error;
      }
      existing = raced;
    }
  }

  const records = await context.legacy.listRecords(session.id);
  const present = await server.listRecords(targetId);
  for (const record of records.slice(present.length)) {
    if (existing.status !== 'active') {
      // A status already set by an earlier run means every record landed.
      break;
    }
    await server.appendRecord(recordInit(record, targetId, legacyStageId, stageId));
  }
  if (session.status !== existing.status) {
    await server.setSessionStatus(targetId, session.status, session.updatedAt);
  }
  return 'copied';
}

/** Copy every legacy runtime session of one course. Throws on a transient failure. */
export async function copyLegacyRuntime(context: RuntimeCopyContext): Promise<number> {
  const { entry } = context;
  const sessions = await context.legacy.listSessions(
    context.legacyStageId,
    context.legacyLearnerKey,
  );
  const done = new Set(entry.sessionsDone ?? []);
  let copied = 0;
  for (const session of sessions) {
    if (done.has(session.id)) continue;
    let outcome: SessionOutcome;
    try {
      outcome = await copySession(session, context);
    } catch (error) {
      const failure = failureOrStop(error);
      if (failure.kind === 'transient' || failure.kind === 'quota') throw error;
      // The server refuses this session as it is: skip it, keep the rest.
      context.log(`Runtime session ${session.id} was not imported: ${failure.reason}`);
      outcome = 'skipped';
    }
    if (outcome === 'copied') copied += 1;
    done.add(session.id);
    entry.sessionsDone = [...done];
    context.checkpoint();
  }
  return copied;
}
