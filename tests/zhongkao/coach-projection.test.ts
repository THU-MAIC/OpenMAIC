import type { RuntimeRecord } from '@openmaic/dsl';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
  type RuntimeStore,
} from '@openmaic/storage';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ensureStudyAttemptsProjected } from '@/lib/server/zhongkao/coach-projection';
import {
  buildCoachStudyAttemptProjection,
  type CoachStudyAttemptProjectionPlan,
} from '@/lib/server/zhongkao/coach-study-attempt-projection';
import { coachRuntimeSessionId } from '@/lib/server/zhongkao/coach-runtime';
import {
  getCoachProblemState,
  recordStudyAttemptsProjected,
} from '@/lib/server/zhongkao/coach-service';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import {
  buildTransferAssignment,
  deriveTransferQuestionId,
} from '@/lib/server/zhongkao/transfer-assignment';
import type { VerifiedTransferQuestion } from '@/lib/server/zhongkao/transfer-question-private';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { assertCoachEvent, type CoachEvent, type CoachEventType } from '@/lib/zhongkao/coach-event';
import {
  loadStudyAttempts,
  saveStudyAttempt,
  studyAttemptRuntimeSessionId,
  zhongkaoStageId,
} from '@/lib/zhongkao/runtime';
import { ZHONGKAO_RUNTIME_KINDS } from '@/lib/zhongkao/runtime-kinds';
import type { StudyAttemptV2 } from '@/lib/zhongkao/study-attempt';

const OWNER_ID = 'fictional-owner-projection-a';
const PROFILE_ID = 'fictional-student-projection-a';
const COACH_SESSION_ID = 'coach-session-projection-saga';
const AGENT_SESSION_ID = 'agent-session-projection-saga';
const RAW_ORIGINAL_RESPONSE = 'PRIVATE_RAW_ORIGINAL_RESPONSE_8QVK';
const RAW_TRANSFER_RESPONSE = 'PRIVATE_RAW_TRANSFER_RESPONSE_4MDP';
const PRIVATE_FULL_SOLUTION = 'PRIVATE_FULL_SOLUTION_7ZWK';

interface FixtureIdentity {
  ownerId: string;
  profileId: string;
  coachSessionId: string;
}

interface ProjectionHarness {
  store: BrowserRuntimeStore;
  deps: {
    store: RuntimeStore;
    ownerId: string;
    agentSessionId: string;
    now: () => string;
  };
  identity: FixtureIdentity;
  learnerKey: string;
  plan: CoachStudyAttemptProjectionPlan;
}

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

function timestamp(seq: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
}

function baseEvent(eventType: CoachEventType, seq: number, identity: FixtureIdentity) {
  return {
    schemaVersion: 1 as const,
    eventId: `${identity.coachSessionId}-event-${seq}`,
    coachSessionId: identity.coachSessionId,
    profileId: identity.profileId,
    eventType,
    createdAt: timestamp(seq),
    agentSessionId: AGENT_SESSION_ID,
    operationId: `${identity.coachSessionId}-operation-${seq}`,
    operationFingerprint: seq.toString(16).padStart(64, '0'),
  };
}

function started(
  seq: number,
  identity: FixtureIdentity,
): Extract<CoachEvent, { eventType: 'coach_started' }> {
  return {
    ...baseEvent('coach_started', seq, identity),
    eventType: 'coach_started',
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSource: { type: 'typed' },
    questionText: 'Solve the fictional equation 2x = 8.',
    sourceUserMessageSeq: 1,
  };
}

function originalSubmission(
  seq: number,
  identity: FixtureIdentity,
): Extract<CoachEvent, { eventType: 'student_attempt_submitted' }> {
  return {
    ...baseEvent('student_attempt_submitted', seq, identity),
    eventType: 'student_attempt_submitted',
    phase: 'original',
    studentResponse: RAW_ORIGINAL_RESPONSE,
    sourceUserMessageSeq: seq + 1,
  };
}

function preparedAssessment(
  seq: number,
  identity: FixtureIdentity,
): Extract<CoachEvent, { eventType: 'original_assessment_prepared' }> {
  return {
    ...baseEvent('original_assessment_prepared', seq, identity),
    eventType: 'original_assessment_prepared',
    assessmentVersion: 1,
    assessmentId: `${identity.coachSessionId}-assessment`,
    questionFingerprint: 'a'.repeat(64),
    questionType: 'numeric',
    verificationRef: `${identity.coachSessionId}-original-verification`,
    assessmentPayload: {
      gradingSpec: {
        schemaVersion: 1,
        type: 'numeric',
        expectedNumericValue: 4,
        tolerance: 0,
      },
      verification: {
        schemaVersion: 1,
        status: 'verified',
        candidateFingerprint: 'b'.repeat(64),
        verifierVersion: 1,
        checks: {
          objectiveType: true,
          questionConsistent: true,
          answerConsistent: true,
          singleAnswerOrExactSet: true,
          middleSchoolScope: true,
        },
      },
    },
  };
}

function unavailableAssessment(
  seq: number,
  identity: FixtureIdentity,
): Extract<CoachEvent, { eventType: 'original_assessment_unavailable' }> {
  return {
    ...baseEvent('original_assessment_unavailable', seq, identity),
    eventType: 'original_assessment_unavailable',
    assessmentVersion: 1,
    questionFingerprint: 'a'.repeat(64),
    reason: 'unsupported_question_type',
  };
}

function originalEvaluation(
  seq: number,
  identity: FixtureIdentity,
  attemptEventId: string,
  assessmentEventId: string,
): Extract<CoachEvent, { eventType: 'original_attempt_evaluated' }> {
  return {
    ...baseEvent('original_attempt_evaluated', seq, identity),
    eventType: 'original_attempt_evaluated',
    assessmentEventId,
    attemptEventId,
    outcome: 'correct',
  };
}

function evaluatedResolution(
  seq: number,
  identity: FixtureIdentity,
  evaluationEventId: string,
): Extract<CoachEvent, { eventType: 'original_resolved'; resolutionKind: 'evaluated_attempt' }> {
  return {
    ...baseEvent('original_resolved', seq, identity),
    eventType: 'original_resolved',
    resolutionSchemaVersion: 3,
    resolutionKind: 'evaluated_attempt',
    evaluationEventId,
  };
}

function legacyEvaluatedResolution(
  seq: number,
  identity: FixtureIdentity,
  attemptEventId: string,
): Extract<CoachEvent, { eventType: 'original_resolved' }> {
  return {
    ...baseEvent('original_resolved', seq, identity),
    eventType: 'original_resolved',
    attemptEventId,
    outcome: 'correct',
  };
}

function fullSolutionRequest(
  seq: number,
  identity: FixtureIdentity,
): Extract<CoachEvent, { eventType: 'full_solution_requested' }> {
  return {
    ...baseEvent('full_solution_requested', seq, identity),
    eventType: 'full_solution_requested',
    phase: 'original',
    sourceUserMessageSeq: seq + 1,
  };
}

function fullSolutionReveal(
  seq: number,
  identity: FixtureIdentity,
  requestEventId: string,
): Extract<CoachEvent, { eventType: 'full_solution_revealed' }> {
  return {
    ...baseEvent('full_solution_revealed', seq, identity),
    eventType: 'full_solution_revealed',
    phase: 'original',
    requestEventId,
    explanation: `${PRIVATE_FULL_SOLUTION}_EXPLANATION`,
    finalAnswer: `${PRIVATE_FULL_SOLUTION}_ANSWER`,
  };
}

function fullSolutionResolution(
  seq: number,
  identity: FixtureIdentity,
  fullSolutionEventId: string,
): Extract<CoachEvent, { eventType: 'original_resolved'; resolutionKind: 'full_solution' }> {
  return {
    ...baseEvent('original_resolved', seq, identity),
    eventType: 'original_resolved',
    resolutionSchemaVersion: 3,
    resolutionKind: 'full_solution',
    fullSolutionEventId,
  };
}

function verifiedTransferQuestion(
  identity: FixtureIdentity,
  originalResolvedEventId: string,
): VerifiedTransferQuestion {
  return {
    validationStatus: 'verified',
    validationRef: `${identity.coachSessionId}-transfer-validation`,
    publicQuestion: {
      schemaVersion: 1,
      transferQuestionId: deriveTransferQuestionId({
        coachSessionId: identity.coachSessionId,
        originalResolvedEventId,
      }),
      type: 'numeric',
      question: 'Solve the fictional transfer equation 3x = 15.',
      knowledgePointIds: ['linear-equations'],
      difficulty: 'same',
    },
    gradingSpec: {
      schemaVersion: 1,
      type: 'numeric',
      expectedNumericValue: 5,
      tolerance: 0,
    },
    verification: {
      schemaVersion: 1,
      status: 'verified',
      candidateFingerprint: 'c'.repeat(64),
      verifierVersion: 1,
      checks: {
        sameKnowledgePoint: true,
        selfContained: true,
        answerConsistent: true,
        answerNotLeaked: true,
        singleAnswerOrExactSet: true,
        middleSchoolScope: true,
        meaningfullyDifferent: true,
      },
    },
  };
}

function transferAssignment(
  seq: number,
  identity: FixtureIdentity,
  originalResolvedEventId: string,
): Extract<CoachEvent, { eventType: 'transfer_question_assigned' }> {
  const assignment = buildTransferAssignment({
    coachSessionId: identity.coachSessionId,
    originalResolvedEventId,
    verifiedQuestion: verifiedTransferQuestion(identity, originalResolvedEventId),
  });
  return {
    ...baseEvent('transfer_question_assigned', seq, identity),
    eventType: 'transfer_question_assigned',
    originalResolvedEventId,
    transferQuestionId: assignment.publicQuestion.transferQuestionId,
    knowledgePointIds: [...assignment.publicQuestion.knowledgePointIds],
    validationRef: assignment.validationRef,
    assignmentSchemaVersion: 1,
    assignmentPayload: {
      publicQuestion: assignment.publicQuestion,
      gradingSpec: assignment.gradingSpec,
      verification: assignment.verification,
    },
  };
}

function transferSubmission(
  seq: number,
  identity: FixtureIdentity,
  transferQuestionId: string,
): Extract<CoachEvent, { eventType: 'transfer_answer_submitted' }> {
  return {
    ...baseEvent('transfer_answer_submitted', seq, identity),
    eventType: 'transfer_answer_submitted',
    phase: 'transfer',
    transferQuestionId,
    studentResponse: RAW_TRANSFER_RESPONSE,
    sourceUserMessageSeq: seq + 1,
  };
}

function transferEvaluation(
  seq: number,
  identity: FixtureIdentity,
  submission: Extract<CoachEvent, { eventType: 'transfer_answer_submitted' }>,
): Extract<CoachEvent, { eventType: 'transfer_answer_evaluated' }> {
  return {
    ...baseEvent('transfer_answer_evaluated', seq, identity),
    eventType: 'transfer_answer_evaluated',
    transferQuestionId: submission.transferQuestionId,
    submissionEventId: submission.eventId,
    outcome: 'correct',
  };
}

function evaluatedHistory(identity: FixtureIdentity): CoachEvent[] {
  const original = originalSubmission(1, identity);
  const assessment = preparedAssessment(2, identity);
  const evaluation = originalEvaluation(3, identity, original.eventId, assessment.eventId);
  const resolution = evaluatedResolution(4, identity, evaluation.eventId);
  const assignment = transferAssignment(5, identity, resolution.eventId);
  const submission = transferSubmission(6, identity, assignment.transferQuestionId);
  return [
    started(0, identity),
    original,
    assessment,
    evaluation,
    resolution,
    assignment,
    submission,
    transferEvaluation(7, identity, submission),
  ];
}

function unassessedHistory(identity: FixtureIdentity): CoachEvent[] {
  const first = originalSubmission(1, identity);
  const unavailable = unavailableAssessment(2, identity);
  const second = originalSubmission(3, identity);
  const request = fullSolutionRequest(4, identity);
  const reveal = fullSolutionReveal(5, identity, request.eventId);
  const resolution = fullSolutionResolution(6, identity, reveal.eventId);
  const assignment = transferAssignment(7, identity, resolution.eventId);
  const submission = transferSubmission(8, identity, assignment.transferQuestionId);
  return [
    started(0, identity),
    first,
    unavailable,
    second,
    request,
    reveal,
    resolution,
    assignment,
    submission,
    transferEvaluation(9, identity, submission),
  ];
}

function fixtureRecords(events: readonly CoachEvent[]): RuntimeRecord[] {
  return events.map((event, seq) => {
    assertCoachEvent(event);
    return {
      id: event.eventId,
      sessionId: coachRuntimeSessionId(event.coachSessionId),
      seq,
      createdAt: event.createdAt,
      subAnchor: event.eventId,
      payload: event,
    };
  });
}

async function seedCoachHistory(
  store: RuntimeStore,
  identity: FixtureIdentity,
  learnerKey: string,
  events: readonly CoachEvent[],
): Promise<RuntimeRecord[]> {
  const sessionId = coachRuntimeSessionId(identity.coachSessionId);
  await store.createSession({
    id: sessionId,
    kind: ZHONGKAO_RUNTIME_KINDS.coachEvent,
    stageId: zhongkaoStageId(identity.profileId),
    learnerKey,
    status: 'active',
    createdAt: events[0]!.createdAt,
    updatedAt: events.at(-1)!.createdAt,
  });
  for (const record of fixtureRecords(events)) {
    await store.appendRecord(
      {
        id: record.id,
        sessionId,
        createdAt: record.createdAt,
        subAnchor: record.subAnchor,
        payload: record.payload,
      },
      { expectedLastSeq: record.seq === 0 ? null : record.seq - 1 },
    );
  }
  return store.listRecords(sessionId);
}

async function createHarness(input: { unassessed?: boolean } = {}): Promise<ProjectionHarness> {
  const identity = {
    ownerId: OWNER_ID,
    profileId: PROFILE_ID,
    coachSessionId: COACH_SESSION_ID,
  };
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(identity.ownerId);
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const records = await seedCoachHistory(
    store,
    identity,
    learnerKey,
    input.unassessed ? unassessedHistory(identity) : evaluatedHistory(identity),
  );
  return {
    store,
    identity,
    learnerKey,
    plan: buildCoachStudyAttemptProjection(records),
    deps: {
      store,
      ownerId: identity.ownerId,
      agentSessionId: AGENT_SESSION_ID,
      now: () => timestamp(30),
    },
  };
}

async function createLegacyFinalizingHarness(): Promise<{
  store: BrowserRuntimeStore;
  deps: ProjectionHarness['deps'];
  identity: FixtureIdentity;
}> {
  const identity = {
    ownerId: OWNER_ID,
    profileId: PROFILE_ID,
    coachSessionId: COACH_SESSION_ID,
  };
  const learnerKey = resolveZhongkaoLearnerKeyFromOwnerId(identity.ownerId);
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const original = originalSubmission(1, identity);
  const resolution = legacyEvaluatedResolution(2, identity, original.eventId);
  const assignment = transferAssignment(3, identity, resolution.eventId);
  const submission = transferSubmission(4, identity, assignment.transferQuestionId);
  await seedCoachHistory(store, identity, learnerKey, [
    started(0, identity),
    original,
    resolution,
    assignment,
    submission,
    transferEvaluation(5, identity, submission),
  ]);
  return {
    store,
    identity,
    deps: {
      store,
      ownerId: identity.ownerId,
      agentSessionId: AGENT_SESSION_ID,
      now: () => timestamp(30),
    },
  };
}

function withStore(harness: ProjectionHarness, store: RuntimeStore) {
  return { ...harness.deps, store };
}

function interceptAppend(
  store: RuntimeStore,
  appendRecord: RuntimeStore['appendRecord'],
): RuntimeStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'appendRecord') return appendRecord;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function payloadField(init: Parameters<RuntimeStore['appendRecord']>[0], field: string): unknown {
  const payload = init.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[field]
    : undefined;
}

function failFirstMatchingAppend(
  baseStore: RuntimeStore,
  matches: (init: Parameters<RuntimeStore['appendRecord']>[0]) => boolean,
  message: string,
): { store: RuntimeStore; appendRecord: ReturnType<typeof vi.fn> } {
  let failed = false;
  const appendRecord = vi.fn(
    async (
      init: Parameters<RuntimeStore['appendRecord']>[0],
      options: Parameters<RuntimeStore['appendRecord']>[1] = {},
    ) => {
      if (!failed && matches(init)) {
        failed = true;
        throw new Error(message);
      }
      return baseStore.appendRecord(init, options);
    },
  );
  return {
    store: interceptAppend(baseStore, appendRecord as unknown as RuntimeStore['appendRecord']),
    appendRecord,
  };
}

async function attempts(harness: ProjectionHarness): Promise<StudyAttemptV2[]> {
  const loaded = await loadStudyAttempts(harness.identity.profileId, {
    store: harness.store,
    learnerKey: harness.learnerKey,
  });
  return loaded.filter((attempt): attempt is StudyAttemptV2 => attempt.schemaVersion === 2);
}

async function rawAttemptRecords(harness: ProjectionHarness): Promise<RuntimeRecord[]> {
  return harness.store.listRecords(
    studyAttemptRuntimeSessionId(harness.identity.profileId, harness.learnerKey),
  );
}

async function coachSnapshot(harness: ProjectionHarness) {
  return getCoachProblemState(
    harness.deps,
    harness.identity.profileId,
    harness.identity.coachSessionId,
  );
}

function projectedEvents(records: readonly RuntimeRecord[]): CoachEvent[] {
  return records
    .map((record) => {
      assertCoachEvent(record.payload);
      return record.payload;
    })
    .filter((event) => event.eventType === 'study_attempts_projected');
}

async function saveExpectedAttempt(
  harness: ProjectionHarness,
  attempt: StudyAttemptV2,
): Promise<void> {
  await saveStudyAttempt(attempt, {
    store: harness.store,
    learnerKey: harness.learnerKey,
  });
}

async function forceProjectionEvent(
  harness: ProjectionHarness,
  projectionRef = harness.plan.projectionRef,
): Promise<void> {
  const snapshot = await coachSnapshot(harness);
  const evaluationEventId = snapshot.state.transfer.evaluationEventId;
  if (!evaluationEventId) throw new Error('fixture transfer evaluation missing');
  await recordStudyAttemptsProjected(harness.deps, {
    profileId: harness.identity.profileId,
    coachSessionId: harness.identity.coachSessionId,
    expectedRevision: snapshot.state.revision,
    evaluationEventId,
    projectionRef,
  });
}

async function expectCoachCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'CoachError', code });
}

describe('ensureStudyAttemptsProjected BrowserRuntimeStore saga', () => {
  it('persists one logical pair, appends one projection event, and completes', async () => {
    const harness = await createHarness();

    const result = await ensureStudyAttemptsProjected(harness.deps, harness.identity);

    expect(result).toMatchObject({ replayed: false, eventAppended: true });
    expect(result.snapshot.state.status).toBe('completed');
    expect(result.snapshot.session.status).toBe('completed');
    expect(await attempts(harness)).toEqual([
      harness.plan.originalAttempt,
      harness.plan.transferAttempt,
    ]);
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
    expect(projectedEvents(result.snapshot.records)).toHaveLength(1);
  });

  it('verifies completed persistence on identical replay without duplicating facts', async () => {
    const harness = await createHarness();
    await ensureStudyAttemptsProjected(harness.deps, harness.identity);

    const replay = await ensureStudyAttemptsProjected(harness.deps, harness.identity);

    expect(replay).toMatchObject({ replayed: true, eventAppended: false });
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
    expect(projectedEvents(replay.snapshot.records)).toHaveLength(1);
  });

  it('keeps finalizing after an original append failure and completes on retry', async () => {
    const harness = await createHarness();
    const failed = failFirstMatchingAppend(
      harness.store,
      (init) => payloadField(init, 'attemptKind') === 'initial',
      'simulated original append failure',
    );

    await expectCoachCode(
      ensureStudyAttemptsProjected(withStore(harness, failed.store), harness.identity),
      'STUDY_ATTEMPT_PERSISTENCE_UNAVAILABLE',
    );
    expect((await coachSnapshot(harness)).state.status).toBe('finalizing');
    expect(await attempts(harness)).toEqual([]);

    const recovered = await ensureStudyAttemptsProjected(harness.deps, harness.identity);
    expect(recovered.snapshot.state.status).toBe('completed');
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
  });

  it('retains the original after a transfer append failure and resumes without a duplicate', async () => {
    const harness = await createHarness();
    const failed = failFirstMatchingAppend(
      harness.store,
      (init) => payloadField(init, 'attemptKind') === 'transfer',
      'simulated transfer append failure',
    );

    await expectCoachCode(
      ensureStudyAttemptsProjected(withStore(harness, failed.store), harness.identity),
      'STUDY_ATTEMPT_PERSISTENCE_UNAVAILABLE',
    );
    expect((await coachSnapshot(harness)).state.status).toBe('finalizing');
    expect((await attempts(harness)).map((attempt) => attempt.attemptKind)).toEqual(['initial']);

    await ensureStudyAttemptsProjected(harness.deps, harness.identity);
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
    expect(projectedEvents((await coachSnapshot(harness)).records)).toHaveLength(1);
  });

  it('keeps both attempts after a projected append failure and appends it on retry', async () => {
    const harness = await createHarness();
    const failed = failFirstMatchingAppend(
      harness.store,
      (init) => payloadField(init, 'eventType') === 'study_attempts_projected',
      'simulated projected append failure',
    );

    await expectCoachCode(
      ensureStudyAttemptsProjected(withStore(harness, failed.store), harness.identity),
      'STUDY_ATTEMPT_PROJECTION_FAILED',
    );
    expect((await coachSnapshot(harness)).state.status).toBe('finalizing');
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
    expect(projectedEvents((await coachSnapshot(harness)).records)).toHaveLength(0);

    await ensureStudyAttemptsProjected(harness.deps, harness.identity);
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
    expect(projectedEvents((await coachSnapshot(harness)).records)).toHaveLength(1);
  });

  it('recovers an uncertain CAS result by reading back the committed attempt', async () => {
    const harness = await createHarness();
    let injected = false;
    const appendRecord = vi.fn(
      async (
        init: Parameters<RuntimeStore['appendRecord']>[0],
        options: Parameters<RuntimeStore['appendRecord']>[1] = {},
      ) => {
        if (!injected && payloadField(init, 'attemptKind') === 'initial') {
          injected = true;
          const committed = await harness.store.appendRecord(init, options);
          throw new RuntimeAppendConflictError(
            init.sessionId,
            options.expectedLastSeq ?? null,
            committed.seq,
          );
        }
        return harness.store.appendRecord(init, options);
      },
    );
    const store = interceptAppend(
      harness.store,
      appendRecord as unknown as RuntimeStore['appendRecord'],
    );

    const result = await ensureStudyAttemptsProjected(withStore(harness, store), harness.identity);

    expect(result.snapshot.state.status).toBe('completed');
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
    expect(projectedEvents(result.snapshot.records)).toHaveLength(1);
  });

  it.each(['original', 'transfer'] as const)(
    'recovers after a real %s CAS loss advances the shared attempt tail',
    async (phase) => {
      const harness = await createHarness();
      let injected = false;
      const appendRecord = vi.fn(
        async (
          init: Parameters<RuntimeStore['appendRecord']>[0],
          options: Parameters<RuntimeStore['appendRecord']>[1] = {},
        ) => {
          const attemptKind = phase === 'original' ? 'initial' : 'transfer';
          if (!injected && payloadField(init, 'attemptKind') === attemptKind) {
            injected = true;
            const competing = {
              ...harness.plan.originalAttempt,
              id: `competing-${phase}-cas-attempt`,
              coachSessionId: `competing-${phase}-cas-session`,
            };
            const winner = await harness.store.appendRecord(
              {
                ...init,
                id: `competing-${phase}-cas-record`,
                subAnchor: competing.id,
                payload: competing,
              },
              options,
            );
            throw new RuntimeAppendConflictError(
              init.sessionId,
              options.expectedLastSeq ?? null,
              winner.seq,
            );
          }
          return harness.store.appendRecord(init, options);
        },
      );

      const result = await ensureStudyAttemptsProjected(
        withStore(
          harness,
          interceptAppend(harness.store, appendRecord as unknown as RuntimeStore['appendRecord']),
        ),
        harness.identity,
      );

      expect(result.snapshot.state.status).toBe('completed');
      expect(
        (await attempts(harness)).filter(
          (attempt) =>
            attempt.id === harness.plan.originalAttempt.id ||
            attempt.id === harness.plan.transferAttempt.id,
        ),
      ).toEqual([harness.plan.originalAttempt, harness.plan.transferAttempt]);
      expect(projectedEvents(result.snapshot.records)).toHaveLength(1);
    },
  );

  it.each(['original', 'transfer'] as const)(
    'fails closed when the %s append resolves without appearing in read-back, then retries',
    async (phase) => {
      const harness = await createHarness();
      let injected = false;
      const appendRecord = vi.fn(
        async (
          init: Parameters<RuntimeStore['appendRecord']>[0],
          options: Parameters<RuntimeStore['appendRecord']>[1] = {},
        ) => {
          const attemptKind = phase === 'original' ? 'initial' : 'transfer';
          if (!injected && payloadField(init, 'attemptKind') === attemptKind) {
            injected = true;
            return {
              ...init,
              seq: (options.expectedLastSeq ?? -1) + 1,
            };
          }
          return harness.store.appendRecord(init, options);
        },
      );
      const store = interceptAppend(
        harness.store,
        appendRecord as unknown as RuntimeStore['appendRecord'],
      );

      await expectCoachCode(
        ensureStudyAttemptsProjected(withStore(harness, store), harness.identity),
        'STUDY_ATTEMPT_PERSISTENCE_UNAVAILABLE',
      );
      expect((await coachSnapshot(harness)).state.status).toBe('finalizing');
      expect(projectedEvents((await coachSnapshot(harness)).records)).toHaveLength(0);

      const recovered = await ensureStudyAttemptsProjected(harness.deps, harness.identity);
      expect(recovered.snapshot.state.status).toBe('completed');
      expect(await rawAttemptRecords(harness)).toHaveLength(2);
      expect(projectedEvents(recovered.snapshot.records)).toHaveLength(1);
    },
  );

  it('keeps finalizing after a projected CAS loss and completes on retry', async () => {
    const harness = await createHarness();
    let injected = false;
    const appendRecord = vi.fn(
      async (
        init: Parameters<RuntimeStore['appendRecord']>[0],
        options: Parameters<RuntimeStore['appendRecord']>[1] = {},
      ) => {
        if (!injected && payloadField(init, 'eventType') === 'study_attempts_projected') {
          injected = true;
          throw new RuntimeAppendConflictError(
            init.sessionId,
            options.expectedLastSeq ?? null,
            options.expectedLastSeq ?? null,
          );
        }
        return harness.store.appendRecord(init, options);
      },
    );

    await expectCoachCode(
      ensureStudyAttemptsProjected(
        withStore(
          harness,
          interceptAppend(harness.store, appendRecord as unknown as RuntimeStore['appendRecord']),
        ),
        harness.identity,
      ),
      'STUDY_ATTEMPT_PROJECTION_FAILED',
    );
    expect((await coachSnapshot(harness)).state.status).toBe('finalizing');
    expect(await rawAttemptRecords(harness)).toHaveLength(2);

    const recovered = await ensureStudyAttemptsProjected(harness.deps, harness.identity);
    expect(recovered.snapshot.state.status).toBe('completed');
    expect(projectedEvents(recovered.snapshot.records)).toHaveLength(1);
  });

  it('verifies a committed projected event after its response is lost', async () => {
    const harness = await createHarness();
    let injected = false;
    const appendRecord = vi.fn(
      async (
        init: Parameters<RuntimeStore['appendRecord']>[0],
        options: Parameters<RuntimeStore['appendRecord']>[1] = {},
      ) => {
        const committed = await harness.store.appendRecord(init, options);
        if (!injected && payloadField(init, 'eventType') === 'study_attempts_projected') {
          injected = true;
          throw new Error('simulated response loss after projected commit');
        }
        return committed;
      },
    );

    const result = await ensureStudyAttemptsProjected(
      withStore(
        harness,
        interceptAppend(harness.store, appendRecord as unknown as RuntimeStore['appendRecord']),
      ),
      harness.identity,
    );

    expect(result.snapshot.state.status).toBe('completed');
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
    expect(projectedEvents(result.snapshot.records)).toHaveLength(1);
  });

  it('converges two concurrent projectors to one raw pair and one terminal event', async () => {
    const harness = await createHarness();

    const results = await Promise.all([
      ensureStudyAttemptsProjected(harness.deps, harness.identity),
      ensureStudyAttemptsProjected(harness.deps, harness.identity),
    ]);

    expect(results.every((result) => result.snapshot.state.status === 'completed')).toBe(true);
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
    expect(projectedEvents((await coachSnapshot(harness)).records)).toHaveLength(1);
  });

  it.each(['original', 'transfer'] as const)(
    'fails closed for a conflicting existing %s deterministic id',
    async (phase) => {
      const harness = await createHarness();
      const expected =
        phase === 'original' ? harness.plan.originalAttempt : harness.plan.transferAttempt;
      await saveExpectedAttempt(harness, {
        ...expected,
        questionSummary: `Conflicting ${phase} long-lived fact`,
      });

      await expectCoachCode(
        ensureStudyAttemptsProjected(harness.deps, harness.identity),
        'STUDY_ATTEMPT_PROJECTION_CONFLICT',
      );
      expect((await coachSnapshot(harness)).state.status).toBe('finalizing');
      expect(projectedEvents((await coachSnapshot(harness)).records)).toHaveLength(0);
    },
  );

  it.each(['original', 'transfer'] as const)(
    'rejects completed replay when the %s attempt is missing',
    async (missingPhase) => {
      const harness = await createHarness();
      if (missingPhase !== 'original') {
        await saveExpectedAttempt(harness, harness.plan.originalAttempt);
      }
      if (missingPhase !== 'transfer') {
        await saveExpectedAttempt(harness, harness.plan.transferAttempt);
      }
      await forceProjectionEvent(harness);

      await expectCoachCode(
        ensureStudyAttemptsProjected(harness.deps, harness.identity),
        'STUDY_ATTEMPT_PROJECTION_CONFLICT',
      );
      expect((await coachSnapshot(harness)).state.status).toBe('completed');
      expect(projectedEvents((await coachSnapshot(harness)).records)).toHaveLength(1);
    },
  );

  it('rejects completed replay when persisted facts mismatch its projection fingerprint', async () => {
    const harness = await createHarness();
    await saveExpectedAttempt(harness, {
      ...harness.plan.originalAttempt,
      questionSummary: 'A conflicting completed original fact',
    });
    await saveExpectedAttempt(harness, harness.plan.transferAttempt);
    await forceProjectionEvent(harness);

    await expectCoachCode(
      ensureStudyAttemptsProjected(harness.deps, harness.identity),
      'STUDY_ATTEMPT_PROJECTION_CONFLICT',
    );
    expect((await coachSnapshot(harness)).state.status).toBe('completed');
    expect(await rawAttemptRecords(harness)).toHaveLength(2);
  });

  it('rejects a conflicting legacy record with the same deterministic completed id', async () => {
    const harness = await createHarness();
    await saveExpectedAttempt(harness, harness.plan.originalAttempt);
    await saveExpectedAttempt(harness, harness.plan.transferAttempt);
    const sessionId = studyAttemptRuntimeSessionId(harness.identity.profileId, harness.learnerKey);
    const records = await harness.store.listRecords(sessionId);
    const expectedLastSeq = records.at(-1)?.seq ?? null;
    await harness.store.appendRecord(
      {
        id: 'conflicting-legacy-completed-record',
        sessionId,
        createdAt: timestamp(20),
        subAnchor: harness.plan.originalAttempt.id,
        payload: {
          schemaVersion: 1,
          id: harness.plan.originalAttempt.id,
          profileId: harness.identity.profileId,
          createdAt: harness.plan.originalAttempt.createdAt,
          subjectId: harness.plan.originalAttempt.subjectId,
          knowledgePointIds: [...harness.plan.originalAttempt.knowledgePointIds],
          questionSummary: 'Conflicting legacy attempt with a reused deterministic id',
          questionSourceType: 'typed',
          attemptKind: 'initial',
          initialOutcome: 'incorrect',
          finalOutcome: 'incorrect',
          studentAttemptedBeforeHelp: true,
          hintsUsed: 0,
          usedKeyHint: false,
          viewedFullAnswer: false,
        },
      },
      { expectedLastSeq },
    );
    await forceProjectionEvent(harness);

    await expectCoachCode(
      ensureStudyAttemptsProjected(harness.deps, harness.identity),
      'STUDY_ATTEMPT_PROJECTION_CONFLICT',
    );
  });

  it('rejects completed replay when its durable projectionRef is not reproducible', async () => {
    const harness = await createHarness();
    await saveExpectedAttempt(harness, harness.plan.originalAttempt);
    await saveExpectedAttempt(harness, harness.plan.transferAttempt);
    await forceProjectionEvent(harness, 'coach-projection:v1:wrong-durable-ref');

    await expectCoachCode(
      ensureStudyAttemptsProjected(harness.deps, harness.identity),
      'STUDY_ATTEMPT_PROJECTION_CONFLICT',
    );
    expect((await coachSnapshot(harness)).state.status).toBe('completed');
  });

  it('maps corrupt completed source history to the terminal projection conflict', async () => {
    const harness = await createLegacyFinalizingHarness();
    const snapshot = await getCoachProblemState(
      harness.deps,
      harness.identity.profileId,
      harness.identity.coachSessionId,
    );
    const evaluationEventId = snapshot.state.transfer.evaluationEventId;
    if (!evaluationEventId) throw new Error('fixture transfer evaluation missing');
    await recordStudyAttemptsProjected(harness.deps, {
      profileId: harness.identity.profileId,
      coachSessionId: harness.identity.coachSessionId,
      expectedRevision: snapshot.state.revision,
      evaluationEventId,
      projectionRef: 'coach-projection:v1:legacy-unreproducible-ref',
    });

    await expectCoachCode(
      ensureStudyAttemptsProjected(harness.deps, harness.identity),
      'STUDY_ATTEMPT_PROJECTION_CONFLICT',
    );
  });

  it('allows an unassessed original to complete with an evaluated transfer', async () => {
    const harness = await createHarness({ unassessed: true });

    const result = await ensureStudyAttemptsProjected(harness.deps, harness.identity);
    const persisted = await attempts(harness);

    expect(result.snapshot.state.status).toBe('completed');
    expect(persisted[0]).toMatchObject({
      attemptKind: 'initial',
      assessmentStatus: 'unassessed',
      unassessedReason: 'unsupported_question_type',
    });
    expect(persisted[0]).not.toHaveProperty('initialOutcome');
    expect(persisted[0]).not.toHaveProperty('finalOutcome');
    expect(persisted[1]).toMatchObject({
      attemptKind: 'transfer',
      assessmentStatus: 'evaluated',
    });
  });

  it('rejects owner, profile, and guessed-session cross-partition projection', async () => {
    const harness = await createHarness();

    await expectCoachCode(
      ensureStudyAttemptsProjected(
        { ...harness.deps, ownerId: 'fictional-owner-projection-b' },
        harness.identity,
      ),
      'COACH_SESSION_NOT_FOUND',
    );
    await expectCoachCode(
      ensureStudyAttemptsProjected(harness.deps, {
        ...harness.identity,
        profileId: 'fictional-student-projection-b',
      }),
      'COACH_SESSION_NOT_FOUND',
    );
    await expectCoachCode(
      ensureStudyAttemptsProjected(harness.deps, {
        ...harness.identity,
        coachSessionId: 'coach-session-projection-guessed',
      }),
      'COACH_SESSION_NOT_FOUND',
    );
    expect(await attempts(harness)).toEqual([]);
    expect((await coachSnapshot(harness)).state.status).toBe('finalizing');
  });

  it('stores no raw answers, grading facts, verifier output, or full solution text', async () => {
    const harness = await createHarness({ unassessed: true });
    await ensureStudyAttemptsProjected(harness.deps, harness.identity);

    const serialized = JSON.stringify(await rawAttemptRecords(harness));
    expect(serialized).not.toContain(RAW_ORIGINAL_RESPONSE);
    expect(serialized).not.toContain(RAW_TRANSFER_RESPONSE);
    expect(serialized).not.toContain(PRIVATE_FULL_SOLUTION);
    expect(serialized).not.toMatch(
      /gradingSpec|expectedNumericValue|acceptedAnswers|correctOptionIds|tolerance|verification|candidateFingerprint|studentResponse|explanation|finalAnswer/iu,
    );
  });
});
