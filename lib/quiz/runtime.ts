import type {
  QuizAttemptPhase,
  QuizAttemptSkeleton,
  RuntimeRecord,
  RuntimeSession,
} from '@openmaic/dsl';
import { RuntimeAppendConflictError, type RuntimeStore } from '@openmaic/storage';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizAnswers } from '@/lib/quiz/persistence';
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

/**
 * Coalesce draft snapshots and serialize every phase through one local chain.
 * `recordPhase` synchronously queues a pending draft first, so submitted and
 * reviewed can never overtake the latest answers even though UI callers remain
 * fire-and-forget.
 */
export function createQuizAttemptWriter(options: QuizAttemptWriterOptions = {}): QuizAttemptWriter {
  const debounceMs = options.debounceMs ?? 500;
  const write = options.write ?? ((input) => recordQuizAttempt(input));
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
    tail = operation.catch(() => {});
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

function samePayload(left: QuizAttemptPayload, right: QuizAttemptPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAnswers(left: QuizAnswers, right: QuizAnswers): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function rolloverAttemptId(attemptId: string, index: number): string {
  return `${attemptId}:retry:${index}`;
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

  return enqueue(store, input.attemptId, () =>
    withAttemptLock(input.attemptId, async () => {
      const timestamp = now();
      const payload: QuizAttemptPayload = {
        payloadVersion: 1,
        phase: input.phase,
        answers: input.answers,
        ...(input.results === undefined ? {} : { results: input.results }),
      };
      let rolloverIndex = 0;
      let sessionId = input.attemptId;

      while (true) {
        let session = await store.getSession(sessionId);
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
          } catch (error) {
            // Without Web Locks, another tab may win the deterministic create
            // after our read. Re-read the winner instead of losing this write.
            session = await store.getSession(sessionId);
            if (!session) throw error;
          }
        }
        assertPartition(session, input.stageId, learnerKey);

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
        const lastRecord = records.at(-1);
        const last = asQuizPayload(lastRecord);

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
        sessionId = rolloverAttemptId(input.attemptId, rolloverIndex);
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
