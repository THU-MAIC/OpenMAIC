import type {
  QuizAttemptPhase,
  QuizAttemptSkeleton,
  RuntimeRecord,
  RuntimeSession,
} from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';
import type { QuestionResult } from '@/lib/quiz/grading';
import {
  clearDraftRecovery,
  clearLegacyQuizStateSnapshot,
  readLegacyQuizStateSnapshot,
  type QuizAnswers,
} from '@/lib/quiz/persistence';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

export interface QuizAttemptPayload extends QuizAttemptSkeleton {
  payloadVersion: 1;
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
}

export interface QuizAttemptRecordInput {
  stageId: string;
  sceneId: string;
  attemptId: string;
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
  /** Begin a distinct retry even when the prior attempt has the same payload. */
  startNewAttempt?: boolean;
}

export interface LegacyQuizAttemptInput {
  stageId: string;
  sceneId: string;
  attemptId: string;
  draftAnswers?: QuizAnswers;
  submittedAnswers?: QuizAnswers;
  results?: QuestionResult[];
}

export interface QuizAttemptRuntimeDeps {
  store?: RuntimeStore;
  learnerKey?: string;
  now?: () => string;
  mintRecordId?: () => string;
}

export class QuizRetryProgressedError extends Error {
  constructor(sessionId: string) {
    super(`Quiz retry ${JSON.stringify(sessionId)} already progressed in another tab`);
    this.name = 'QuizRetryProgressedError';
  }
}

export interface QuizAttemptState {
  sessionId: string;
  status: RuntimeSession['status'];
  phase: QuizAttemptPhase;
  answers: QuizAnswers;
  results?: QuestionResult[];
}

export interface LoadedQuizAttemptState {
  /** Learner-scoped deterministic root id used by every new write/retry. */
  attemptId: string;
  state?: QuizAttemptState;
}

export interface QuizAttemptStateInput {
  stageId: string;
  sceneId: string;
}

export type QuizDraftInput = Omit<QuizAttemptRecordInput, 'phase' | 'results'>;

export interface QuizAttemptWriter {
  scheduleDraft(input: QuizDraftInput): void;
  flushDraft(): Promise<void>;
  recordPhase(input: QuizAttemptRecordInput): Promise<void>;
  cancelDraft(): void;
}

export interface QuizAttemptWriterOptions {
  debounceMs?: number;
  write?: (input: QuizAttemptRecordInput) => Promise<void>;
  onError?: (error: unknown) => void;
}

const PHASE_ORDER: Record<QuizAttemptPhase, number> = {
  draft: 0,
  submitted: 1,
  reviewed: 2,
};

const queues = new WeakMap<RuntimeStore, Map<string, Promise<void>>>();
const writerTails = new Map<string, Set<Promise<void>>>();

async function awaitQueuedWriterLineage(attemptId: string): Promise<void> {
  let queueKey = attemptId;
  while (true) {
    while (true) {
      const pending = writerTails.get(queueKey);
      if (!pending?.size) break;
      await Promise.all(pending);
    }
    const parent = queueKey.replace(/:retry:\d+$/, '');
    if (parent === queueKey) return;
    queueKey = parent;
  }
}

async function awaitQueuedAttemptLineage(store: RuntimeStore, attemptId: string): Promise<void> {
  let queueKey = attemptId;
  while (true) {
    const queued = queues.get(store)?.get(queueKey);
    if (queued) await queued;
    const parent = queueKey.replace(/:retry:\d+$/, '');
    if (parent === queueKey) return;
    queueKey = parent;
  }
}

/**
 * Coalesce draft snapshots and serialize every phase through one local chain.
 * `recordPhase` synchronously queues a pending draft first, so submitted and
 * reviewed can never overtake the latest answers even though UI callers remain
 * fire-and-forget.
 */
export function createQuizAttemptWriter(options: QuizAttemptWriterOptions = {}): QuizAttemptWriter {
  const debounceMs = options.debounceMs ?? 500;
  const write =
    options.write ??
    (async (input) => {
      await recordQuizAttempt(input);
      clearDraftRecovery(input.sceneId, input.attemptId, input.answers);
    });
  const onError = options.onError ?? (() => {});
  let pendingDraft: QuizDraftInput | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const run = (input: QuizAttemptRecordInput): Promise<void> => {
    const operation = tail.then(() => write(input));
    void operation.catch(onError);
    const settled = operation.catch(() => {});
    tail = settled;
    let attemptTails = writerTails.get(input.attemptId);
    if (!attemptTails) {
      attemptTails = new Set();
      writerTails.set(input.attemptId, attemptTails);
    }
    attemptTails.add(settled);
    void settled.finally(() => {
      attemptTails.delete(settled);
      if (attemptTails.size === 0 && writerTails.get(input.attemptId) === attemptTails) {
        writerTails.delete(input.attemptId);
      }
    });
    return operation;
  };

  const flushDraft = (): Promise<void> => {
    clearTimer();
    if (!pendingDraft) return tail;
    const input = pendingDraft;
    pendingDraft = undefined;
    return run({ ...input, phase: 'draft' });
  };

  return {
    scheduleDraft(input) {
      pendingDraft = input;
      clearTimer();
      timer = setTimeout(() => {
        void flushDraft();
      }, debounceMs);
    },
    flushDraft,
    recordPhase(input) {
      void flushDraft();
      return run(input);
    },
    cancelDraft() {
      clearTimer();
      pendingDraft = undefined;
    },
  };
}

function enqueue<T>(store: RuntimeStore, attemptId: string, work: () => Promise<T>): Promise<T> {
  let storeQueues = queues.get(store);
  if (!storeQueues) {
    storeQueues = new Map();
    queues.set(store, storeQueues);
  }
  const prior = storeQueues.get(attemptId) ?? Promise.resolve();
  const current = prior.catch(() => {}).then(work);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  storeQueues.set(attemptId, settled);
  void settled.finally(() => {
    if (storeQueues.get(attemptId) === settled) storeQueues.delete(attemptId);
  });
  return current;
}

async function withAttemptLock<T>(attemptId: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`maic:quiz-attempt:${attemptId}`, work);
  }
  return work();
}

function mintId(): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `quiz-record:${suffix}`;
}

function asQuizPayload(record: RuntimeRecord | undefined): QuizAttemptPayload | undefined {
  if (!record || typeof record.payload !== 'object' || record.payload === null) return undefined;
  const payload = record.payload as Partial<QuizAttemptPayload>;
  if (
    payload.payloadVersion !== 1 ||
    (payload.phase !== 'draft' && payload.phase !== 'submitted' && payload.phase !== 'reviewed') ||
    typeof payload.answers !== 'object' ||
    payload.answers === null ||
    Array.isArray(payload.answers)
  ) {
    return undefined;
  }
  return payload as QuizAttemptPayload;
}

function attemptIdSegment(value: string): string {
  return encodeURIComponent(value);
}

export function quizAttemptId(stageId: string, sceneId: string, learnerKey: string): string {
  return [
    'quiz-attempt',
    attemptIdSegment(stageId),
    attemptIdSegment(sceneId),
    attemptIdSegment(learnerKey),
  ].join(':');
}

async function readLatestQuizAttemptState(
  input: QuizAttemptStateInput,
  store: RuntimeStore,
  learnerKey: string,
): Promise<QuizAttemptState | undefined> {
  const sessions = await store.listSessions(input.stageId, learnerKey);
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (session.kind !== 'quizAttempt') continue;
    const records = await store.listRecords(session.id, { sceneId: input.sceneId });
    const payload = asQuizPayload(records.at(-1));
    if (!payload) continue;
    return {
      sessionId: session.id,
      status: session.status,
      phase: payload.phase,
      answers: payload.answers,
      ...(payload.phase === 'reviewed'
        ? { results: Array.isArray(payload.results) ? payload.results : [] }
        : {}),
    };
  }
  return undefined;
}

async function migrateLegacyQuizState(
  input: QuizAttemptStateInput,
  store: RuntimeStore,
  learnerKey: string,
  deps: QuizAttemptRuntimeDeps,
): Promise<void> {
  const legacySnapshot = readLegacyQuizStateSnapshot(input.sceneId);
  if (!legacySnapshot.hasState) return;

  const existing = await readLatestQuizAttemptState(input, store, learnerKey);
  const { submitted, draft, attemptId: legacyAttemptId } = legacySnapshot;
  const legacyPhase: QuizAttemptPhase | undefined =
    submitted?.kind === 'reviewing'
      ? 'reviewed'
      : submitted?.kind === 'answering'
        ? 'submitted'
        : draft
          ? 'draft'
          : undefined;
  const legacyPointsToNewAttempt =
    legacyAttemptId !== null &&
    (!existing ||
      (existing.sessionId !== legacyAttemptId &&
        !existing.sessionId.startsWith(`${legacyAttemptId}:retry:`)));
  const legacyPayloadMatchesExisting =
    existing !== undefined &&
    legacyPhase === existing.phase &&
    (legacyPhase === 'reviewed' && submitted?.kind === 'reviewing'
      ? sameAnswers(submitted.answers, existing.answers) &&
        JSON.stringify(submitted.results) === JSON.stringify(existing.results ?? [])
      : legacyPhase === 'submitted' && submitted?.kind === 'answering'
        ? sameAnswers(submitted.answers, existing.answers)
        : legacyPhase === 'draft' && draft !== null
          ? sameAnswers(draft, existing.answers)
          : false);
  const shouldMigrate =
    legacyPointsToNewAttempt ||
    (legacyPhase !== undefined &&
      (!existing ||
        PHASE_ORDER[legacyPhase] > PHASE_ORDER[existing.phase] ||
        (PHASE_ORDER[legacyPhase] === PHASE_ORDER[existing.phase] &&
          !legacyPayloadMatchesExisting)));

  if (shouldMigrate) {
    const attemptId =
      (legacyPointsToNewAttempt ? legacyAttemptId : existing?.sessionId) ??
      quizAttemptId(input.stageId, input.sceneId, learnerKey);
    if (submitted?.kind === 'reviewing') {
      await backfillQuizAttempt(
        {
          ...input,
          attemptId,
          submittedAnswers: submitted.answers,
          results: submitted.results,
        },
        { ...deps, store, learnerKey },
      );
    } else if (submitted?.kind === 'answering') {
      await backfillQuizAttempt(
        { ...input, attemptId, submittedAnswers: submitted.answers },
        { ...deps, store, learnerKey },
      );
    } else if (draft) {
      await backfillQuizAttempt(
        { ...input, attemptId, draftAnswers: draft },
        { ...deps, store, learnerKey },
      );
    } else if (legacyPointsToNewAttempt) {
      await recordQuizAttempt(
        { ...input, attemptId, phase: 'draft', answers: {} },
        { ...deps, store, learnerKey },
      );
    }
  }

  // Legacy state is deleted only after every required runtime write succeeds.
  // Delete only the values this migration read; a newer recovery journal may
  // have arrived while its RuntimeStore writes were in flight.
  clearLegacyQuizStateSnapshot(input.sceneId, legacySnapshot);
}

/** Load the learner's latest quiz state, migrating legacy localStorage once. */
export async function loadQuizAttemptState(
  input: QuizAttemptStateInput,
  deps: QuizAttemptRuntimeDeps = {},
): Promise<LoadedQuizAttemptState> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const attemptId = quizAttemptId(input.stageId, input.sceneId, learnerKey);
  // A UI transition can expose the next consumer while its fire-and-forget
  // writer is still queued. Wait for both its private phase tail and the
  // RuntimeStore queue before opening a read.
  await awaitQueuedWriterLineage(attemptId);
  await awaitQueuedAttemptLineage(store, attemptId);
  await migrateLegacyQuizState(input, store, learnerKey, deps);
  let state = await withAttemptLock(attemptId, () =>
    readLatestQuizAttemptState(input, store, learnerKey),
  );
  if (state && state.sessionId !== attemptId) {
    // A shadow-written or rolled-over attempt can queue its next write under
    // this non-root session id, even after the session itself is completed.
    // Drain that lineage before choosing the authoritative latest attempt.
    await awaitQueuedWriterLineage(state.sessionId);
    await awaitQueuedAttemptLineage(store, state.sessionId);
    state = await withAttemptLock(rootAttemptId(state.sessionId), () =>
      readLatestQuizAttemptState(input, store, learnerKey),
    );
  }

  // Older shadow writers could append reviewed and crash before completing
  // the session. Replaying the same fact invokes the atomic tail-CAS repair.
  if (state?.phase === 'reviewed' && state.status === 'active') {
    await recordQuizAttempt(
      {
        ...input,
        attemptId: state.sessionId,
        phase: 'reviewed',
        answers: state.answers,
        results: state.results ?? [],
      },
      { ...deps, store, learnerKey },
    );
    state = await readLatestQuizAttemptState(input, store, learnerKey);
  }

  return {
    attemptId: state?.status === 'active' ? state.sessionId : attemptId,
    state,
  };
}

function samePayload(left: QuizAttemptPayload, right: QuizAttemptPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAnswers(left: QuizAnswers, right: QuizAnswers): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rolloverAttemptId(attemptId: string, index: number): string {
  return `${attemptId}:retry:${index}`;
}

function rootAttemptId(attemptId: string): string {
  return attemptId.replace(/(?::retry:\d+)+$/, '');
}

function compareSessionCreationOrder(left: RuntimeSession, right: RuntimeSession): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function isInactiveSessionAppendError(error: unknown, sessionId: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(
    `cannot append to session ${JSON.stringify(sessionId)} with status`,
  );
}

function assertPartition(session: RuntimeSession, stageId: string, learnerKey: string): void {
  if (
    session.kind !== 'quizAttempt' ||
    session.stageId !== stageId ||
    session.learnerKey !== learnerKey
  ) {
    throw new Error(
      `Quiz attempt ${JSON.stringify(session.id)} does not belong to stage ` +
        `${JSON.stringify(stageId)} and learner ${JSON.stringify(learnerKey)}`,
    );
  }
}

/**
 * Append one immutable quiz lifecycle fact. Calls for one attempt are serialized
 * so rapid draft writes cannot overtake submit or review writes.
 */
export async function recordQuizAttempt(
  input: QuizAttemptRecordInput,
  deps: QuizAttemptRuntimeDeps = {},
): Promise<void> {
  const store = deps.store ?? getRuntimeStore();
  const learnerKey = deps.learnerKey ?? (await getLearnerKey());
  const now = deps.now ?? (() => new Date().toISOString());
  const mintRecordId = deps.mintRecordId ?? mintId;
  const rootId = rootAttemptId(input.attemptId);

  return enqueue(store, rootId, () =>
    withAttemptLock(rootId, async () => {
      const timestamp = now();
      const latestState = input.startNewAttempt
        ? await readLatestQuizAttemptState(input, store, learnerKey)
        : undefined;
      const authoritativeCompletedSession =
        latestState?.status === 'completed'
          ? await store.getSession(latestState.sessionId)
          : undefined;
      const payload: QuizAttemptPayload = {
        payloadVersion: 1,
        phase: input.phase,
        answers: input.answers,
        ...(input.results === undefined ? {} : { results: input.results }),
      };
      let rolloverIndex = 0;
      let sessionId = input.attemptId;
      let originSession: RuntimeSession | undefined;

      while (true) {
        let session = await store.getSession(sessionId);
        let created = false;
        if (!session) {
          try {
            session = await store.createSession({
              id: sessionId,
              kind: 'quizAttempt',
              stageId: input.stageId,
              learnerKey,
              status: 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
            });
            created = true;
          } catch (error) {
            // Without Web Locks, another tab may win the deterministic create
            // after our read. Re-read the winner instead of losing this write.
            session = await store.getSession(sessionId);
            if (!session) throw error;
          }
        }
        assertPartition(session, input.stageId, learnerKey);
        if (sessionId === input.attemptId) originSession = session;

        const records = await store.listRecords(sessionId);
        const foreignAnchor = records.find(
          (record) => record.sceneId !== undefined && record.sceneId !== input.sceneId,
        );
        if (foreignAnchor) {
          throw new Error(
            `Quiz attempt ${JSON.stringify(sessionId)} is already anchored to scene ` +
              `${JSON.stringify(foreignAnchor.sceneId)}`,
          );
        }

        // Canonical retry ids are scanned from one, but a stale caller may
        // already point at a later flat retry or a newer nested legacy retry.
        // Never move that caller backward onto an older active sibling.
        if (
          !created &&
          sessionId !== input.attemptId &&
          originSession &&
          compareSessionCreationOrder(session, originSession) <= 0
        ) {
          rolloverIndex += 1;
          sessionId = rolloverAttemptId(rootId, rolloverIndex);
          continue;
        }

        const lastRecord = records.at(-1);
        const last = asQuizPayload(lastRecord);

        if (input.startNewAttempt && !created) {
          // A concurrent retry may already have created the first active child.
          // Reuse it instead of minting a second active branch whose newer
          // session ordering would hide writes that still resolve to this one.
          if (sessionId !== input.attemptId && session.status === 'active') {
            // A child with a durable fact already represents the retry. An
            // empty child can remain after create succeeds but append fails;
            // fall through so this call writes the missing draft marker.
            if (last?.phase === 'draft' && Object.keys(last.answers).length === 0) return;
            if (
              last &&
              authoritativeCompletedSession &&
              authoritativeCompletedSession.id !== sessionId &&
              compareSessionCreationOrder(session, authoritativeCompletedSession) < 0
            ) {
              rolloverIndex += 1;
              sessionId = rolloverAttemptId(rootId, rolloverIndex);
              continue;
            }
            if (last) throw new QuizRetryProgressedError(sessionId);
          } else {
            rolloverIndex += 1;
            sessionId = rolloverAttemptId(rootId, rolloverIndex);
            continue;
          }
        }

        if (session.status === 'active') {
          if (last && PHASE_ORDER[payload.phase] < PHASE_ORDER[last.phase]) return;

          // An active session with a reviewed tail can exist from an older
          // client that appended before its separate completion write. Heal
          // only the status, guarded by the record tail in the same transaction.
          if (last && samePayload(last, payload) && payload.phase !== 'reviewed') return;
          if (last && lastRecord && samePayload(last, payload)) {
            try {
              await store.setSessionStatus(sessionId, 'completed', timestamp, {
                expectedLastSeq: lastRecord.seq,
              });
            } catch (error) {
              if (error instanceof RuntimeAppendConflictError) continue;
              throw error;
            }
            return;
          }

          try {
            await store.appendRecord(
              {
                id: mintRecordId(),
                sessionId,
                sceneId: input.sceneId,
                createdAt: timestamp,
                payload,
              },
              {
                expectedLastSeq: lastRecord?.seq ?? null,
                ...(payload.phase === 'reviewed'
                  ? { sessionTransition: { status: 'completed' as const, updatedAt: timestamp } }
                  : {}),
              },
            );
          } catch (error) {
            if (error instanceof RuntimeAppendConflictError) continue;
            if (!isInactiveSessionAppendError(error, sessionId)) throw error;
            const raced = await store.getSession(sessionId);
            if (!raced || raced.status === 'active') throw error;
            assertPartition(raced, input.stageId, learnerKey);
            // Another tab completed between our active read and append. Re-run
            // the loop so the immutable completed attempt rolls forward.
            continue;
          }
          return;
        }

        if (last && samePayload(last, payload)) return;
        if (
          last &&
          PHASE_ORDER[payload.phase] < PHASE_ORDER[last.phase] &&
          sameAnswers(payload.answers, last.answers)
        ) {
          return;
        }

        rolloverIndex += 1;
        sessionId = rolloverAttemptId(rootId, rolloverIndex);
      }
    }),
  );
}

/** Backfill the strongest legacy localStorage state without deleting legacy keys. */
export async function backfillQuizAttempt(
  input: LegacyQuizAttemptInput,
  deps: QuizAttemptRuntimeDeps = {},
): Promise<void> {
  const base = {
    stageId: input.stageId,
    sceneId: input.sceneId,
    attemptId: input.attemptId,
  };
  if (input.submittedAnswers) {
    await recordQuizAttempt({ ...base, phase: 'submitted', answers: input.submittedAnswers }, deps);
    if (input.results !== undefined) {
      await recordQuizAttempt(
        {
          ...base,
          phase: 'reviewed',
          answers: input.submittedAnswers,
          results: input.results,
        },
        deps,
      );
    }
    return;
  }
  if (input.draftAnswers) {
    await recordQuizAttempt({ ...base, phase: 'draft', answers: input.draftAnswers }, deps);
  }
}
