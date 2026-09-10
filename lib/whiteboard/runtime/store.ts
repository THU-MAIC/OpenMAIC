import type { RuntimeRecord, RuntimeSession } from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';

import { getLearnerKey } from '@/lib/runtime/learner-key';
import { registerRuntimeStorageResetHook } from '@/lib/runtime/config';
import { getRuntimeStore } from '@/lib/runtime/store';
import { withRuntimeStorageSharedLock } from '@/lib/utils/chat-storage-lock';

import {
  EMPTY_WHITEBOARD_RUNTIME_STATE,
  applyWhiteboardRuntimeOperation,
  foldWhiteboardRuntimeRecords,
  publicWhiteboardRuntimeState,
} from './fold';
import {
  WHITEBOARD_RUNTIME_KIND,
  WhiteboardRuntimeNoChangeError,
  type AppendWhiteboardRecordInput,
  type AppendWhiteboardRecordResult,
  type FoldedWhiteboardRuntimeDetails,
  type FoldedWhiteboardRuntimeState,
  type WhiteboardRuntimePayloadV1,
} from './types';
import { assertWhiteboardRuntimePayload, cloneCanonicalJson, sha256Canonical } from './validate';

export class WhiteboardRuntimeSessionAmbiguousError extends Error {
  override readonly name = 'WhiteboardRuntimeSessionAmbiguousError';
  readonly code = 'WHITEBOARD_RUNTIME_SESSION_AMBIGUOUS';
}

export class WhiteboardRuntimeSessionInvariantError extends Error {
  override readonly name = 'WhiteboardRuntimeSessionInvariantError';
  readonly code = 'WHITEBOARD_RUNTIME_SESSION_INVARIANT';
}

export interface WhiteboardRuntimeServiceDeps {
  store: RuntimeStore;
  resolveLearnerKey: () => string | Promise<string>;
  now?: () => string;
  withMaintenanceLock?: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface WhiteboardRuntimeService {
  read(stageId: string): Promise<FoldedWhiteboardRuntimeState>;
  append(input: AppendWhiteboardRecordInput): Promise<AppendWhiteboardRecordResult>;
  /** Internal read-only recovery seam; never appends or retries a mutation. */
  reconcileOperation(
    stageId: string,
    payload: WhiteboardRuntimePayloadV1,
  ): Promise<
    | { status: 'exact'; committedSeq: number; state: FoldedWhiteboardRuntimeState }
    | { status: 'other'; state: FoldedWhiteboardRuntimeState }
    | { status: 'empty'; state: FoldedWhiteboardRuntimeState }
  >;
}

export function whiteboardRuntimeSessionId(stageId: string, learnerKey: string): string {
  return `whiteboard:${encodeURIComponent(stageId)}:${encodeURIComponent(learnerKey)}`;
}

function assertStageId(stageId: string): void {
  if (stageId.length === 0) throw new Error('WHITEBOARD_RUNTIME_STAGE_ID_INVALID');
}

function assertLearnerKey(learnerKey: string): void {
  if (learnerKey.length === 0) throw new Error('WHITEBOARD_RUNTIME_LEARNER_KEY_INVALID');
}

function assertSessionIdentity(
  session: RuntimeSession,
  expected: { id?: string; stageId: string; learnerKey: string },
): void {
  if (
    (expected.id !== undefined && session.id !== expected.id) ||
    session.kind !== WHITEBOARD_RUNTIME_KIND ||
    session.stageId !== expected.stageId ||
    session.learnerKey !== expected.learnerKey ||
    session.status !== 'active'
  ) {
    throw new WhiteboardRuntimeSessionInvariantError(
      `Whiteboard RuntimeSession ${JSON.stringify(session.id)} violates the application invariant`,
    );
  }
}

async function selectSession(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
): Promise<RuntimeSession | undefined> {
  const sessions = (await store.listSessions(stageId, learnerKey)).filter(
    (session) => session.kind === WHITEBOARD_RUNTIME_KIND,
  );
  const active = sessions.filter((session) => session.status === 'active');
  if (active.length > 1) {
    throw new WhiteboardRuntimeSessionAmbiguousError(
      `Multiple active whiteboard RuntimeSessions exist for stage ${JSON.stringify(stageId)}`,
    );
  }
  if (sessions.some((session) => session.status !== 'active')) {
    throw new WhiteboardRuntimeSessionInvariantError(
      `Inactive whiteboard RuntimeSession exists for stage ${JSON.stringify(stageId)}`,
    );
  }
  if (active.length === 1) {
    assertSessionIdentity(active[0]!, { stageId, learnerKey });
    return active[0];
  }
  const deterministic = await store.getSession(whiteboardRuntimeSessionId(stageId, learnerKey));
  if (deterministic) {
    assertSessionIdentity(deterministic, {
      id: whiteboardRuntimeSessionId(stageId, learnerKey),
      stageId,
      learnerKey,
    });
    return deterministic;
  }
  return undefined;
}

async function ensureSession(
  store: RuntimeStore,
  stageId: string,
  learnerKey: string,
  now: () => string,
): Promise<RuntimeSession> {
  const selected = await selectSession(store, stageId, learnerKey);
  if (selected) return selected;
  const id = whiteboardRuntimeSessionId(stageId, learnerKey);
  const timestamp = now();
  try {
    const created = await store.createSession({
      id,
      kind: WHITEBOARD_RUNTIME_KIND,
      stageId,
      learnerKey,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    assertSessionIdentity(created, { id, stageId, learnerKey });
    return created;
  } catch (error) {
    const winner = await store.getSession(id);
    if (!winner) throw error;
    assertSessionIdentity(winner, { id, stageId, learnerKey });
    return winner;
  }
}

async function foldSession(
  store: RuntimeStore,
  session: RuntimeSession,
): Promise<FoldedWhiteboardRuntimeDetails> {
  return foldWhiteboardRuntimeRecords(session.id, await store.listRecords(session.id));
}

async function findExactReplay(
  details: FoldedWhiteboardRuntimeDetails,
  payload: WhiteboardRuntimePayloadV1,
): Promise<number | null> {
  const existing = details.operations[payload.operationId];
  if (!existing) return null;
  if (existing.digest !== (await sha256Canonical(payload))) {
    throw new Error('WHITEBOARD_RUNTIME_OPERATION_CONFLICT');
  }
  return existing.seq;
}

export function createWhiteboardRuntimeService(
  deps: WhiteboardRuntimeServiceDeps,
): WhiteboardRuntimeService {
  const now = deps.now ?? (() => new Date().toISOString());
  const lock = deps.withMaintenanceLock ?? withRuntimeStorageSharedLock;

  const read = async (stageId: string): Promise<FoldedWhiteboardRuntimeState> => {
    assertStageId(stageId);
    const learnerKey = await deps.resolveLearnerKey();
    assertLearnerKey(learnerKey);
    return lock(async () => {
      const session = await selectSession(deps.store, stageId, learnerKey);
      return session
        ? publicWhiteboardRuntimeState(await foldSession(deps.store, session))
        : EMPTY_WHITEBOARD_RUNTIME_STATE;
    });
  };

  const append = async (
    input: AppendWhiteboardRecordInput,
  ): Promise<AppendWhiteboardRecordResult> => {
    assertStageId(input.stageId);
    if (
      input.expectedLastSeq !== null &&
      (!Number.isSafeInteger(input.expectedLastSeq) || input.expectedLastSeq < 0)
    ) {
      throw new Error('WHITEBOARD_RUNTIME_EXPECTED_LAST_SEQ_INVALID');
    }
    const payload = cloneCanonicalJson(input.payload);
    assertWhiteboardRuntimePayload(payload);
    const learnerKey = await deps.resolveLearnerKey();
    assertLearnerKey(learnerKey);

    return lock(async () => {
      const session = await ensureSession(deps.store, input.stageId, learnerKey, now);
      const before = await foldSession(deps.store, session);
      const replaySeq = await findExactReplay(before, payload);
      if (replaySeq !== null) {
        return {
          committedSeq: replaySeq,
          state: publicWhiteboardRuntimeState(before),
          replayed: true,
        };
      }
      if (before.lastSeq !== input.expectedLastSeq) {
        throw new RuntimeAppendConflictError(session.id, input.expectedLastSeq, before.lastSeq);
      }
      // Any existing valid domain record makes RuntimeStore authoritative, even if a future
      // operation does not materialize a board. The fold transition separately rejects raw
      // import-after-state records that bypass this typed service boundary.
      if (payload.operation.kind === 'legacy_snapshot_imported' && before.lastSeq !== null) {
        throw new Error('WHITEBOARD_RUNTIME_IMPORT_AFTER_STATE');
      }
      try {
        await applyWhiteboardRuntimeOperation(session.id, before.whiteboard, payload.operation);
      } catch (error) {
        if (error instanceof WhiteboardRuntimeNoChangeError) {
          throw new WhiteboardRuntimeNoChangeError(
            error.reason,
            publicWhiteboardRuntimeState(before),
          );
        }
        throw error;
      }

      let appended: RuntimeRecord;
      try {
        appended = await deps.store.appendRecord(
          {
            id: payload.operationId,
            sessionId: session.id,
            createdAt: now(),
            payload,
          },
          { expectedLastSeq: input.expectedLastSeq },
        );
      } catch (error) {
        let after: FoldedWhiteboardRuntimeDetails;
        try {
          after = await foldSession(deps.store, session);
        } catch {
          throw error;
        }
        const recoveredSeq = await findExactReplay(after, payload);
        if (recoveredSeq !== null) {
          return {
            committedSeq: recoveredSeq,
            state: publicWhiteboardRuntimeState(after),
            replayed: true,
          };
        }
        if (
          after.lastSeq !== input.expectedLastSeq &&
          !(error instanceof RuntimeAppendConflictError)
        ) {
          throw new RuntimeAppendConflictError(session.id, input.expectedLastSeq, after.lastSeq);
        }
        throw error;
      }

      const after = await foldSession(deps.store, session);
      const committedSeq = await findExactReplay(after, payload);
      if (committedSeq === null || committedSeq !== appended.seq) {
        throw new Error('WHITEBOARD_RUNTIME_POST_COMMIT_VERIFICATION_FAILED');
      }
      return {
        committedSeq,
        state: publicWhiteboardRuntimeState(after),
        replayed: false,
      };
    });
  };

  const reconcileOperation: WhiteboardRuntimeService['reconcileOperation'] = async (
    stageId,
    inputPayload,
  ) => {
    assertStageId(stageId);
    const payload = cloneCanonicalJson(inputPayload);
    assertWhiteboardRuntimePayload(payload);
    const learnerKey = await deps.resolveLearnerKey();
    assertLearnerKey(learnerKey);

    return lock(async () => {
      const session = await selectSession(deps.store, stageId, learnerKey);
      if (!session) return { status: 'empty', state: EMPTY_WHITEBOARD_RUNTIME_STATE };
      const details = await foldSession(deps.store, session);
      const state = publicWhiteboardRuntimeState(details);
      const committedSeq = await findExactReplay(details, payload);
      if (committedSeq !== null) return { status: 'exact', committedSeq, state };
      return details.lastSeq === null ? { status: 'empty', state } : { status: 'other', state };
    });
  };

  return Object.freeze({ read, append, reconcileOperation });
}

let defaultService: WhiteboardRuntimeService | undefined;

registerRuntimeStorageResetHook(() => {
  defaultService = undefined;
});

/** Internal foundation service. No Agent/UI caller is registered in PR1. */
export function getWhiteboardRuntimeService(): WhiteboardRuntimeService {
  return (defaultService ??= createWhiteboardRuntimeService({
    store: getRuntimeStore(),
    resolveLearnerKey: getLearnerKey,
  }));
}
