import type { AICallFn } from '@openmaic/generation';
import {
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
  type RuntimeStore,
} from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { buildCoachToolSuccessOutput } from '@/lib/server/agent-runtime/zhongkao-coach-tool';
import {
  completeOriginalAttemptAssessment,
  recoverPreparedOriginalAssessment,
  type CoachOriginalAssessmentDependencies,
} from '@/lib/server/zhongkao/coach-original-assessment';
import { ensureFullSolutionResolution } from '@/lib/server/zhongkao/coach-presentation';
import {
  generateVerifiedOriginalAssessment,
  type OriginalAssessmentCandidate,
} from '@/lib/server/zhongkao/original-assessment-private';
import {
  abandonCoachProblem,
  getCoachProblemState,
  recordFullSolutionRevealed,
  recordHintIssued,
  recordOriginalAssessmentPrepared,
  recordOriginalAttemptEvaluation,
  recordOriginalResolvedFromEvaluation,
  recordOriginalResolvedFromFullSolution,
  requestCoachFullSolution,
  requestCoachHint,
  startCoachProblem,
  submitCoachAttempt,
  type CoachActionResult,
  type CoachServiceDeps,
} from '@/lib/server/zhongkao/coach-service';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import { CoachError } from '@/lib/zhongkao/coach-errors';
import type { CoachEvent } from '@/lib/zhongkao/coach-event';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile, zhongkaoStageId } from '@/lib/zhongkao/runtime';

const NOW = Date.parse('2026-08-30T08:00:00.000Z');
const PROFILE_ID = 'student-original-assessment';

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

interface Harness {
  store: RuntimeStore;
  deps: CoachServiceDeps;
}

function harness(): Harness {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `coach-original-assessment-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  let clock = 0;
  return {
    store,
    deps: {
      store,
      ownerId: 'owner-fictional-original-assessment',
      agentSessionId: 'agent-fictional-original-assessment',
      now: () => new Date(NOW + clock++ * 1_000).toISOString(),
    },
  };
}

async function seedProfile(h: Harness): Promise<void> {
  await saveStudentProfile(
    createInitialStudentProfile({
      profileId: PROFILE_ID,
      createdAt: new Date(NOW).toISOString(),
    }),
    {
      store: h.store,
      learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
      now: () => new Date(NOW).toISOString(),
      mintRecordId: () => 'profile-original-assessment-record',
    },
  );
}

async function start(h: Harness, questionText = 'What number solves 2x = 8?') {
  await seedProfile(h);
  return startCoachProblem(h.deps, {
    profileId: PROFILE_ID,
    subjectId: 'math',
    knowledgePointIds: ['linear-equations'],
    questionSource: { type: 'typed' },
    message: { seq: 1, text: questionText },
  });
}

function events(result: CoachActionResult): CoachEvent[] {
  return result.snapshot.records.map((record) => record.payload as CoachEvent);
}

function lastEvent(result: CoachActionResult): CoachEvent {
  return events(result).at(-1)!;
}

function acceptedVerification(): string {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: 'accept',
    checks: {
      objectiveType: true,
      questionConsistent: true,
      answerConsistent: true,
      singleAnswerOrExactSet: true,
      middleSchoolScope: true,
    },
  });
}

function modelResponses(...values: unknown[]): ReturnType<typeof vi.fn<AICallFn>> {
  let index = 0;
  return vi.fn<AICallFn>(async () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    if (value instanceof Error) throw value;
    if (typeof value === 'string') return value;
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('missing fake model response');
    return encoded;
  });
}

function assessmentDeps(
  h: Harness,
  candidate: OriginalAssessmentCandidate = {
    schemaVersion: 1,
    type: 'numeric',
    expectedNumericValue: 4,
  },
): CoachOriginalAssessmentDependencies & {
  generationCall: ReturnType<typeof vi.fn<AICallFn>>;
  originalAssessmentVerificationCall: ReturnType<typeof vi.fn<AICallFn>>;
} {
  return {
    ...h.deps,
    generationCall: vi.fn<AICallFn>(async () => JSON.stringify(candidate)),
    originalAssessmentVerificationCall: vi.fn<AICallFn>(async () => acceptedVerification()),
  };
}

async function submit(
  h: Harness,
  previous: CoachActionResult,
  seq: number,
  text: string,
): Promise<CoachActionResult> {
  return submitCoachAttempt(h.deps, {
    profileId: PROFILE_ID,
    coachSessionId: previous.snapshot.state.coachSessionId,
    expectedRevision: previous.snapshot.state.revision,
    message: { seq, text },
  });
}

async function complete(
  deps: CoachOriginalAssessmentDependencies,
  attempted: CoachActionResult,
): Promise<CoachActionResult> {
  const attempt = lastEvent(attempted);
  if (attempt.eventType !== 'student_attempt_submitted') throw new Error('expected attempt');
  return completeOriginalAttemptAssessment(deps, {
    profileId: PROFILE_ID,
    coachSessionId: attempted.snapshot.state.coachSessionId,
    attemptEventId: attempt.eventId,
  });
}

async function prepareAssessment(
  h: Harness,
  started: CoachActionResult,
  previous: CoachActionResult,
): Promise<CoachActionResult> {
  const startRecord = events(started)[0];
  if (!startRecord || startRecord.eventType !== 'coach_started') {
    throw new Error('expected start');
  }
  const generation = assessmentDeps(h);
  const verified = await generateVerifiedOriginalAssessment(
    {
      generateCandidate: generation.generationCall,
      verifyCandidate: generation.originalAssessmentVerificationCall,
    },
    {
      coachSessionId: started.snapshot.state.coachSessionId,
      subjectId: startRecord.subjectId,
      knowledgePointIds: startRecord.knowledgePointIds,
      questionText: startRecord.questionText,
      questionSource: startRecord.questionSource,
    },
  );
  return recordOriginalAssessmentPrepared(h.deps, {
    profileId: PROFILE_ID,
    coachSessionId: started.snapshot.state.coachSessionId,
    expectedRevision: previous.snapshot.state.revision,
    verifiedAssessment: verified,
  });
}

describe('durable original assessment and deterministic evaluation', () => {
  it('persists assessment before evaluation and resolves only from a correct evaluation', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');
    const deps = assessmentDeps(h);

    const completed = await complete(deps, attempted);
    const persisted = events(completed);

    expect(persisted.map((event) => event.eventType)).toEqual([
      'coach_started',
      'student_attempt_submitted',
      'original_assessment_prepared',
      'original_attempt_evaluated',
      'original_resolved',
    ]);
    const assessment = persisted[2]!;
    const evaluation = persisted[3]!;
    const resolution = persisted[4]!;
    expect(evaluation).toMatchObject({
      eventType: 'original_attempt_evaluated',
      assessmentEventId: assessment.eventId,
      attemptEventId: persisted[1]!.eventId,
      outcome: 'correct',
    });
    expect(resolution).toMatchObject({
      eventType: 'original_resolved',
      resolutionSchemaVersion: 3,
      resolutionKind: 'evaluated_attempt',
      evaluationEventId: evaluation.eventId,
    });
    expect(resolution).not.toHaveProperty('outcome');
    expect(completed.snapshot.state.original.outcome).toBe('correct');
    expect(deps.generationCall).toHaveBeenCalledTimes(1);
    expect(deps.originalAssessmentVerificationCall).toHaveBeenCalledTimes(1);

    const sessions = await h.store.listSessions(
      zhongkaoStageId(PROFILE_ID),
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    expect(sessions.map((session) => session.kind).sort()).toEqual([
      'zhongkaoCoachEvent',
      'zhongkaoStudentProfile',
    ]);
  });

  it('recovers incorrect, incorrect, correct in submission order without regenerating the key', async () => {
    const h = harness();
    const started = await start(h);
    const deps = assessmentDeps(h);

    const firstAttempt = await submit(h, started, 2, '5');
    const first = await complete(deps, firstAttempt);
    expect(first.snapshot.state.original.resolved).toBe(false);

    const secondAttempt = await submit(h, first, 3, '6');
    const second = await complete({ ...h.deps }, secondAttempt);
    expect(second.snapshot.state.original.resolved).toBe(false);

    const thirdAttempt = await submit(h, second, 4, '4');
    const third = await complete({ ...h.deps }, thirdAttempt);
    const evaluations = events(third).filter(
      (event) => event.eventType === 'original_attempt_evaluated',
    );

    expect(evaluations.map((event) => event.outcome)).toEqual([
      'incorrect',
      'incorrect',
      'correct',
    ]);
    expect(evaluations.map((event) => event.attemptEventId)).toEqual(
      third.snapshot.state.original.attemptEventIds,
    );
    expect(third.snapshot.state.original.outcome).toBe('correct');
    expect(third.snapshot.state.original.resolutionKind).toBe('evaluated_attempt');
    expect(deps.generationCall).toHaveBeenCalledTimes(1);
    expect(deps.originalAssessmentVerificationCall).toHaveBeenCalledTimes(1);
  });

  it('evaluates every attempt that accumulated before the assessment became available', async () => {
    const h = harness();
    const started = await start(h);
    const firstAttempt = await submit(h, started, 2, '4');
    const secondAttempt = await submit(h, firstAttempt, 3, '5');
    const thirdAttempt = await submit(h, secondAttempt, 4, '4');

    const completed = await complete(assessmentDeps(h), thirdAttempt);
    const evaluations = events(completed).filter(
      (event) => event.eventType === 'original_attempt_evaluated',
    );

    expect(evaluations.map((event) => event.outcome)).toEqual(['correct', 'incorrect', 'correct']);
    expect(evaluations.map((event) => event.attemptEventId)).toEqual(
      completed.snapshot.state.original.attemptEventIds,
    );
    expect(completed.snapshot.state.original.evaluatedAttemptEventIds).toEqual(
      completed.snapshot.state.original.attemptEventIds,
    );
    expect(completed.snapshot.state.original.correctEvaluationEventId).toBe(
      evaluations.at(-1)!.eventId,
    );
    expect(completed.snapshot.state.original.resolved).toBe(true);
  });

  it('grades the persisted answer independently of hint exposure', async () => {
    const h = harness();
    const started = await start(h);
    const requested = await requestCoachHint(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: started.snapshot.state.revision,
      message: { seq: 2, text: 'Give one small hint.' },
    });
    const request = lastEvent(requested);
    if (request.eventType !== 'hint_requested') throw new Error('expected hint request');
    const issued = await recordHintIssued(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: requested.snapshot.state.revision,
      requestEventId: request.eventId,
      hintText: 'Use the inverse operation.',
    });
    const attempted = await submit(h, issued, 3, '4');
    const completed = await complete(assessmentDeps(h), attempted);

    expect(completed.snapshot.state.original.hintsIssued).toBe(1);
    expect(
      events(completed).find((event) => event.eventType === 'original_attempt_evaluated'),
    ).toMatchObject({ outcome: 'correct' });
  });

  it('keeps a private answer canary only in the server event, never in public tool output', async () => {
    const h = harness();
    const privateCanary = 'PRIVATE_ORIGINAL_ANSWER_CANARY_7F31';
    const visibleAnswer = 'VISIBLE_CORRECT_ANSWER';
    const started = await start(h, 'State the exact fictional access phrase.');
    const attempted = await submit(h, started, 2, visibleAnswer);
    const completed = await complete(
      assessmentDeps(h, {
        schemaVersion: 1,
        type: 'exact_short_answer',
        acceptedAnswers: [visibleAnswer, privateCanary],
      }),
      attempted,
    );

    const privateSerialized = JSON.stringify(events(completed));
    expect(privateSerialized).toContain(privateCanary);
    const publicOutput = buildCoachToolSuccessOutput(completed.snapshot, {
      replayed: false,
      eventAppended: true,
    });
    const publicSerialized = JSON.stringify(publicOutput);
    expect(publicSerialized).not.toContain(privateCanary);
    expect(publicSerialized).not.toMatch(
      /assessmentPayload|gradingSpec|expectedNumericValue|acceptedAnswers|verificationRef/u,
    );
  });
});

describe('original assessment recovery and concurrency', () => {
  it('recovers after assessment persistence without another model call', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');
    const startEvent = events(started)[0];
    if (!startEvent || startEvent.eventType !== 'coach_started') throw new Error('expected start');
    const generation = assessmentDeps(h);
    const verified = await generateVerifiedOriginalAssessment(
      {
        generateCandidate: generation.generationCall,
        verifyCandidate: generation.originalAssessmentVerificationCall,
      },
      {
        coachSessionId: started.snapshot.state.coachSessionId,
        subjectId: startEvent.subjectId,
        knowledgePointIds: startEvent.knowledgePointIds,
        questionText: startEvent.questionText,
        questionSource: startEvent.questionSource,
      },
    );
    const prepared = await recordOriginalAssessmentPrepared(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: attempted.snapshot.state.revision,
      verifiedAssessment: verified,
    });

    const recovered = await recoverPreparedOriginalAssessment(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
    });

    expect(recovered).toBeDefined();
    expect(events(recovered!).map((event) => event.eventType)).toEqual([
      'coach_started',
      'student_attempt_submitted',
      'original_assessment_prepared',
      'original_attempt_evaluated',
      'original_resolved',
    ]);
    expect(prepared.snapshot.state.original.resolved).toBe(false);
    expect(generation.generationCall).toHaveBeenCalledTimes(1);
    expect(generation.originalAssessmentVerificationCall).toHaveBeenCalledTimes(1);
  });

  it('drains a prepared assessment backlog before full-solution resolution', async () => {
    const h = harness();
    const started = await start(h);
    const first = await submit(h, started, 2, '3');
    const startEvent = events(started)[0];
    if (!startEvent || startEvent.eventType !== 'coach_started') throw new Error('expected start');
    const generation = assessmentDeps(h);
    const verified = await generateVerifiedOriginalAssessment(
      {
        generateCandidate: generation.generationCall,
        verifyCandidate: generation.originalAssessmentVerificationCall,
      },
      {
        coachSessionId: started.snapshot.state.coachSessionId,
        subjectId: startEvent.subjectId,
        knowledgePointIds: startEvent.knowledgePointIds,
        questionText: startEvent.questionText,
        questionSource: startEvent.questionSource,
      },
    );
    const prepared = await recordOriginalAssessmentPrepared(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: first.snapshot.state.revision,
      verifiedAssessment: verified,
    });
    const second = await submit(h, prepared, 3, '2');
    const requested = await requestCoachFullSolution(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: second.snapshot.state.revision,
      message: { seq: 4, text: 'show the full solution' },
    });
    const revealed = await recordFullSolutionRevealed(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: requested.snapshot.state.revision,
      requestEventId: lastEvent(requested).eventId,
      explanation: 'Fictional authorized explanation.',
      finalAnswer: '4',
    });

    await expect(
      recordOriginalResolvedFromFullSolution(h.deps, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        expectedRevision: revealed.snapshot.state.revision,
        fullSolutionEventId: lastEvent(revealed).eventId,
      }),
    ).rejects.toMatchObject({ code: 'COACH_ACTION_NOT_ALLOWED' });

    const resolved = await ensureFullSolutionResolution(h.deps, revealed.snapshot);
    expect(resolved).toMatchObject({ replayed: false, eventAppended: true });
    expect(
      events(resolved).filter((event) => event.eventType === 'original_attempt_evaluated'),
    ).toHaveLength(2);
    expect(resolved.snapshot.state.original).toMatchObject({
      evaluatedAttemptEventIds: first.snapshot.state.original.attemptEventIds.concat(
        lastEvent(second).eventId,
      ),
      resolved: true,
      resolutionKind: 'full_solution',
    });
    expect(resolved.snapshot.state.original).not.toHaveProperty('outcome');
    expect(generation.generationCall).toHaveBeenCalledTimes(1);
    expect(generation.originalAssessmentVerificationCall).toHaveBeenCalledTimes(1);
  });

  it('blocks new submission and abandonment when a pending backlog follows a correct evaluation', async () => {
    const h = harness();
    const started = await start(h);
    const first = await submit(h, started, 2, '4');
    const second = await submit(h, first, 3, '5');
    const third = await submit(h, second, 4, '6');
    const startRecord = events(started)[0];
    if (!startRecord || startRecord.eventType !== 'coach_started') {
      throw new Error('expected start');
    }
    const generation = assessmentDeps(h);
    const verified = await generateVerifiedOriginalAssessment(
      {
        generateCandidate: generation.generationCall,
        verifyCandidate: generation.originalAssessmentVerificationCall,
      },
      {
        coachSessionId: started.snapshot.state.coachSessionId,
        subjectId: startRecord.subjectId,
        knowledgePointIds: startRecord.knowledgePointIds,
        questionText: startRecord.questionText,
        questionSource: startRecord.questionSource,
      },
    );
    const prepared = await recordOriginalAssessmentPrepared(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: third.snapshot.state.revision,
      verifiedAssessment: verified,
    });
    const assessmentEvent = lastEvent(prepared);
    if (assessmentEvent.eventType !== 'original_assessment_prepared') {
      throw new Error('expected assessment');
    }
    const firstAttempt = lastEvent(first);
    const secondAttempt = lastEvent(second);
    const firstEvaluated = await recordOriginalAttemptEvaluation(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: prepared.snapshot.state.revision,
      assessmentEventId: assessmentEvent.eventId,
      attemptEventId: firstAttempt.eventId,
    });
    const firstEvaluation = lastEvent(firstEvaluated);
    const window = await recordOriginalAttemptEvaluation(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: firstEvaluated.snapshot.state.revision,
      assessmentEventId: assessmentEvent.eventId,
      attemptEventId: secondAttempt.eventId,
    });

    expect(
      events(window)
        .filter((event) => event.eventType === 'original_attempt_evaluated')
        .map((event) => event.outcome),
    ).toEqual(['correct', 'incorrect']);
    expect(window.snapshot.state.original).toMatchObject({
      resolved: false,
      authoritativeCorrectEvaluationEventId: firstEvaluation.eventId,
    });
    expect(window.snapshot.state.original.correctEvaluationEventId).toBeUndefined();

    await expect(submit(h, window, 5, 'another answer')).rejects.toMatchObject({
      code: 'COACH_ACTION_NOT_ALLOWED',
    });
    await expect(
      abandonCoachProblem(h.deps, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        expectedRevision: window.snapshot.state.revision,
        message: { seq: 6, text: 'stop this problem' },
      }),
    ).rejects.toMatchObject({ code: 'COACH_ACTION_NOT_ALLOWED' });

    const persisted = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    expect(persisted.state.revision).toBe(window.snapshot.state.revision);
    expect(persisted.state.original.attemptEventIds).toHaveLength(3);
    expect(
      persisted.records.some(
        (record) => (record.payload as CoachEvent).eventType === 'problem_abandoned',
      ),
    ).toBe(false);
    expect(persisted.state.original.resolved).toBe(false);
  });

  it('recovers after evaluation persistence by appending only the causal resolution', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');
    const deps = assessmentDeps(h);
    const startEvent = events(started)[0];
    const attemptEvent = lastEvent(attempted);
    if (!startEvent || startEvent.eventType !== 'coach_started') throw new Error('expected start');
    if (attemptEvent.eventType !== 'student_attempt_submitted') throw new Error('expected attempt');
    const verified = await generateVerifiedOriginalAssessment(
      {
        generateCandidate: deps.generationCall,
        verifyCandidate: deps.originalAssessmentVerificationCall,
      },
      {
        coachSessionId: started.snapshot.state.coachSessionId,
        subjectId: startEvent.subjectId,
        knowledgePointIds: startEvent.knowledgePointIds,
        questionText: startEvent.questionText,
        questionSource: startEvent.questionSource,
      },
    );
    const prepared = await recordOriginalAssessmentPrepared(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: attempted.snapshot.state.revision,
      verifiedAssessment: verified,
    });
    const evaluated = await recordOriginalAttemptEvaluation(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: prepared.snapshot.state.revision,
      assessmentEventId: lastEvent(prepared).eventId,
      attemptEventId: attemptEvent.eventId,
    });

    const recovered = await recoverPreparedOriginalAssessment(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
    });

    expect(recovered).toBeDefined();
    expect(
      events(recovered!).filter((event) => event.eventType === 'original_attempt_evaluated'),
    ).toHaveLength(1);
    expect(events(recovered!).at(-1)).toMatchObject({
      eventType: 'original_resolved',
      evaluationEventId: lastEvent(evaluated).eventId,
    });
  });

  it('recovers reveal then correct evaluation crash window as an evaluated resolution', async () => {
    const h = harness();
    const started = await start(h);
    const first = await submit(h, started, 2, '4');
    const second = await submit(h, first, 3, '5');
    const requested = await requestCoachFullSolution(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: second.snapshot.state.revision,
      message: { seq: 4, text: 'show the full solution' },
    });
    const revealed = await recordFullSolutionRevealed(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: requested.snapshot.state.revision,
      requestEventId: lastEvent(requested).eventId,
      explanation: 'Fictional authorized explanation.',
      finalAnswer: '4',
    });
    const prepared = await prepareAssessment(h, started, revealed);
    const assessment = lastEvent(prepared);
    const firstAttempt = lastEvent(first);
    const secondAttempt = lastEvent(second);
    const firstEvaluated = await recordOriginalAttemptEvaluation(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: prepared.snapshot.state.revision,
      assessmentEventId: assessment.eventId,
      attemptEventId: firstAttempt.eventId,
    });
    const firstEvaluation = lastEvent(firstEvaluated);
    const crashSnapshot = await recordOriginalAttemptEvaluation(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: firstEvaluated.snapshot.state.revision,
      assessmentEventId: assessment.eventId,
      attemptEventId: secondAttempt.eventId,
    });
    expect(crashSnapshot.snapshot.state.original).toMatchObject({
      resolved: false,
      viewedFullAnswer: true,
      authoritativeCorrectEvaluationEventId: firstEvaluation.eventId,
    });

    const recovered = await recoverPreparedOriginalAssessment(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
    });
    expect(recovered).toBeDefined();
    expect(lastEvent(recovered!)).toMatchObject({
      eventType: 'original_resolved',
      resolutionSchemaVersion: 3,
      resolutionKind: 'evaluated_attempt',
      evaluationEventId: firstEvaluation.eventId,
    });
    expect(recovered!.snapshot.state.original).toMatchObject({
      resolutionKind: 'evaluated_attempt',
      outcome: 'correct',
      viewedFullAnswer: true,
    });
  });

  it('converges a concurrent pending evaluation and reveal to evaluated resolution', async () => {
    const h = harness();
    const started = await start(h);
    const first = await submit(h, started, 2, '3');
    const second = await submit(h, first, 3, '4');
    const prepared = await prepareAssessment(h, started, second);
    const assessment = lastEvent(prepared);
    const firstEvaluated = await recordOriginalAttemptEvaluation(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: prepared.snapshot.state.revision,
      assessmentEventId: assessment.eventId,
      attemptEventId: lastEvent(first).eventId,
    });
    const requested = await requestCoachFullSolution(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: firstEvaluated.snapshot.state.revision,
      message: { seq: 4, text: 'show the full solution' },
    });
    const request = lastEvent(requested);
    const raced = await Promise.allSettled([
      recordOriginalAttemptEvaluation(h.deps, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        expectedRevision: requested.snapshot.state.revision,
        assessmentEventId: assessment.eventId,
        attemptEventId: lastEvent(second).eventId,
      }),
      recordFullSolutionRevealed(h.deps, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        expectedRevision: requested.snapshot.state.revision,
        requestEventId: request.eventId,
        explanation: 'Fictional authorized explanation.',
        finalAnswer: '4',
      }),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);

    let current = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    if (!current.state.original.viewedFullAnswer) {
      current = (
        await recordFullSolutionRevealed(h.deps, {
          profileId: PROFILE_ID,
          coachSessionId: started.snapshot.state.coachSessionId,
          expectedRevision: current.state.revision,
          requestEventId: request.eventId,
          explanation: 'Fictional authorized explanation.',
          finalAnswer: '4',
        })
      ).snapshot;
    }
    const recovered = await recoverPreparedOriginalAssessment(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
    });
    expect(recovered).toBeDefined();
    const durable = events(recovered!);
    expect(durable.filter((event) => event.eventType === 'full_solution_revealed')).toHaveLength(1);
    expect(
      durable.filter((event) => event.eventType === 'original_attempt_evaluated'),
    ).toHaveLength(2);
    expect(durable.filter((event) => event.eventType === 'original_resolved')).toHaveLength(1);
    expect(recovered!.snapshot.state.original).toMatchObject({
      resolutionKind: 'evaluated_attempt',
      outcome: 'correct',
      viewedFullAnswer: true,
    });
  });

  it('replays the deterministic resolution when a concurrent CAS writer loses', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');
    const prepared = await prepareAssessment(h, started, attempted);
    const evaluated = await recordOriginalAttemptEvaluation(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: prepared.snapshot.state.revision,
      assessmentEventId: lastEvent(prepared).eventId,
      attemptEventId: lastEvent(attempted).eventId,
    });
    const input = {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: evaluated.snapshot.state.revision,
      evaluationEventId: lastEvent(evaluated).eventId,
    };
    const results = await Promise.all([
      recordOriginalResolvedFromEvaluation(h.deps, input),
      recordOriginalResolvedFromEvaluation(h.deps, input),
    ]);

    expect(results.filter((result) => result.eventAppended)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(
      events(results[0]!).filter((event) => event.eventType === 'original_resolved'),
    ).toHaveLength(1);
  });

  it('converges concurrent identical preparation and evaluation to one logical chain', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');
    const attempt = lastEvent(attempted);
    if (attempt.eventType !== 'student_attempt_submitted') throw new Error('expected attempt');
    const left = assessmentDeps(h);
    const right = assessmentDeps(h);

    const settled = await Promise.allSettled([
      completeOriginalAttemptAssessment(left, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        attemptEventId: attempt.eventId,
      }),
      completeOriginalAttemptAssessment(right, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        attemptEventId: attempt.eventId,
      }),
    ]);

    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
    const snapshot = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    expect(
      events({ snapshot, replayed: false, eventAppended: false }).filter(
        (event) => event.eventType === 'original_assessment_prepared',
      ),
    ).toHaveLength(1);
    expect(
      events({ snapshot, replayed: false, eventAppended: false }).filter(
        (event) => event.eventType === 'original_attempt_evaluated',
      ),
    ).toHaveLength(1);
    expect(
      events({ snapshot, replayed: false, eventAppended: false }).filter(
        (event) => event.eventType === 'original_resolved',
      ),
    ).toHaveLength(1);
  });

  it('fails closed when concurrent candidates produce different grading facts', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');
    const attempt = lastEvent(attempted);
    if (attempt.eventType !== 'student_attempt_submitted') throw new Error('expected attempt');

    const settled = await Promise.allSettled([
      completeOriginalAttemptAssessment(assessmentDeps(h), {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        attemptEventId: attempt.eventId,
      }),
      completeOriginalAttemptAssessment(
        assessmentDeps(h, {
          schemaVersion: 1,
          type: 'numeric',
          expectedNumericValue: 5,
        }),
        {
          profileId: PROFILE_ID,
          coachSessionId: started.snapshot.state.coachSessionId,
          attemptEventId: attempt.eventId,
        },
      ),
    ]);

    const rejected = settled.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'COACH_EVENT_CONFLICT',
    });
    const snapshot = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    const persisted = events({ snapshot, replayed: false, eventAppended: false });
    expect(
      persisted.filter((event) => event.eventType === 'original_assessment_prepared'),
    ).toHaveLength(1);
    expect(
      persisted.filter((event) => event.eventType === 'original_attempt_evaluated'),
    ).toHaveLength(1);
  });

  it('recovers one durable unavailable event after its append response is lost', async () => {
    const h = harness();
    const started = await start(h, 'Explain this fictional open-ended argument.');
    const attempted = await submit(h, started, 2, 'A fictional explanation.');
    let responseLost = false;
    const responseLossStore = new Proxy(h.store, {
      get(target, property, receiver) {
        if (property === 'appendRecord') {
          return async (
            init: Parameters<RuntimeStore['appendRecord']>[0],
            options: Parameters<RuntimeStore['appendRecord']>[1],
          ) => {
            const record = await target.appendRecord(init, options);
            if (
              !responseLost &&
              (init.payload as { eventType?: string }).eventType ===
                'original_assessment_unavailable'
            ) {
              responseLost = true;
              throw new Error('simulated unavailable append response loss');
            }
            return record;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const assessment = assessmentDeps(h, { schemaVersion: 1, type: 'unsupported' });

    const recovered = await complete({ ...assessment, store: responseLossStore }, attempted);
    expect(recovered).toMatchObject({
      replayed: true,
      eventAppended: false,
      code: 'ORIGINAL_ASSESSMENT_UNAVAILABLE',
    });
    expect(responseLost).toBe(true);
    expect(assessment.generationCall).toHaveBeenCalledTimes(2);
    expect(assessment.originalAssessmentVerificationCall).not.toHaveBeenCalled();

    const replay = await complete(h.deps, attempted);
    expect(replay).toMatchObject({
      replayed: true,
      eventAppended: false,
      code: 'ORIGINAL_ASSESSMENT_UNAVAILABLE',
    });
    const persisted = events(replay);
    expect(
      persisted.filter((event) => event.eventType === 'original_assessment_unavailable'),
    ).toHaveLength(1);
    expect(
      persisted.filter((event) => event.eventType === 'original_assessment_prepared'),
    ).toHaveLength(0);
    expect(
      persisted.filter((event) => event.eventType === 'original_attempt_evaluated'),
    ).toHaveLength(0);
  });

  it('keeps a lost unavailable CAS pending and retryable without a terminal event', async () => {
    const h = harness();
    const started = await start(h, 'Explain this fictional open-ended argument.');
    const attempted = await submit(h, started, 2, 'A fictional explanation.');
    let blocked = false;
    const conflictingStore = new Proxy(h.store, {
      get(target, property, receiver) {
        if (property === 'appendRecord') {
          return async (
            init: Parameters<RuntimeStore['appendRecord']>[0],
            options: Parameters<RuntimeStore['appendRecord']>[1],
          ) => {
            if (
              (init.payload as { eventType?: string }).eventType ===
              'original_assessment_unavailable'
            ) {
              blocked = true;
              const expected = options?.expectedLastSeq ?? null;
              throw new RuntimeAppendConflictError(init.sessionId, expected, (expected ?? -1) + 1);
            }
            return target.appendRecord(init, options);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const unsupported = assessmentDeps(h, { schemaVersion: 1, type: 'unsupported' });

    await expect(
      complete({ ...unsupported, store: conflictingStore }, attempted),
    ).rejects.toMatchObject({ code: 'COACH_SESSION_CONFLICT' });
    expect(blocked).toBe(true);
    const pending = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    expect(pending.state.original.assessment).toEqual({ status: 'pending' });
    expect(
      events({ snapshot: pending, replayed: false, eventAppended: false }).filter(
        (event) => event.eventType === 'original_assessment_unavailable',
      ),
    ).toHaveLength(0);

    const retried = await complete(assessmentDeps(h), attempted);
    expect(retried.snapshot.state.original.assessment.status).toBe('prepared');
    expect(
      events(retried).filter((event) => event.eventType === 'original_assessment_unavailable'),
    ).toHaveLength(0);
  });

  it('does not persist unavailable when assessment recovery is cancelled', async () => {
    const h = harness();
    const started = await start(h, 'Explain this fictional open-ended argument.');
    const attempted = await submit(h, started, 2, 'A fictional explanation.');
    const controller = new AbortController();
    controller.abort();
    const unsupported = assessmentDeps(h, { schemaVersion: 1, type: 'unsupported' });

    await expect(
      complete({ ...unsupported, abortSignal: controller.signal }, attempted),
    ).rejects.toThrow('aborted');
    expect(unsupported.generationCall).not.toHaveBeenCalled();
    const pending = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    expect(pending.state.original.assessment).toEqual({ status: 'pending' });
    expect(
      events({ snapshot: pending, replayed: false, eventAppended: false }).filter(
        (event) => event.eventType === 'original_assessment_unavailable',
      ),
    ).toHaveLength(0);
  });

  it('does not persist unavailable when cancellation arrives at the append boundary', async () => {
    const h = harness();
    const started = await start(h, 'Explain this fictional open-ended argument.');
    const attempted = await submit(h, started, 2, 'A fictional explanation.');
    const controller = new AbortController();
    const unsupported = assessmentDeps(h, { schemaVersion: 1, type: 'unsupported' });
    let generationCalls = 0;
    let unsupportedDecisionReached = false;
    unsupported.generationCall.mockImplementation(async () => {
      generationCalls += 1;
      if (generationCalls === 2) unsupportedDecisionReached = true;
      return JSON.stringify({ schemaVersion: 1, type: 'unsupported' });
    });
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let blocked = false;
    const blockingStore = new Proxy(h.store, {
      get(target, property, receiver) {
        if (property === 'listRecords') {
          return async (...args: Parameters<RuntimeStore['listRecords']>) => {
            if (unsupportedDecisionReached && !blocked) {
              blocked = true;
              signalReadStarted();
              await readReleased;
            }
            return target.listRecords(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;

    const completing = complete(
      { ...unsupported, store: blockingStore, abortSignal: controller.signal },
      attempted,
    );
    await readStarted;
    controller.abort();
    releaseRead();

    await expect(completing).rejects.toThrow('aborted');
    expect(blocked).toBe(true);
    const pending = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    expect(pending.state.original.assessment).toEqual({ status: 'pending' });
    expect(
      events({ snapshot: pending, replayed: false, eventAppended: false }).filter(
        (event) => event.eventType === 'original_assessment_unavailable',
      ),
    ).toHaveLength(0);
  });

  it('converges concurrent unsupported workers to one durable unavailable authority', async () => {
    const h = harness();
    const started = await start(h, 'Explain this fictional open-ended argument.');
    const attempted = await submit(h, started, 2, 'A fictional explanation.');
    const attempt = lastEvent(attempted);
    if (attempt.eventType !== 'student_attempt_submitted') throw new Error('expected attempt');
    const left = assessmentDeps(h, { schemaVersion: 1, type: 'unsupported' });
    const right = assessmentDeps(h, { schemaVersion: 1, type: 'unsupported' });

    const settled = await Promise.allSettled([
      completeOriginalAttemptAssessment(left, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        attemptEventId: attempt.eventId,
      }),
      completeOriginalAttemptAssessment(right, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        attemptEventId: attempt.eventId,
      }),
    ]);
    const results = settled.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason;
      return result.value;
    });

    expect(results.every((result) => result.code === 'ORIGINAL_ASSESSMENT_UNAVAILABLE')).toBe(true);
    expect(results.filter((result) => result.eventAppended)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(left.generationCall).toHaveBeenCalledTimes(2);
    expect(right.generationCall).toHaveBeenCalledTimes(2);
    expect(left.originalAssessmentVerificationCall).not.toHaveBeenCalled();
    expect(right.originalAssessmentVerificationCall).not.toHaveBeenCalled();

    const snapshot = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    const persisted = events({ snapshot, replayed: false, eventAppended: false });
    expect(
      persisted.filter((event) => event.eventType === 'original_assessment_unavailable'),
    ).toHaveLength(1);
    expect(
      persisted.filter((event) => event.eventType === 'original_assessment_prepared'),
    ).toHaveLength(0);
    expect(
      persisted.filter((event) => event.eventType === 'original_attempt_evaluated'),
    ).toHaveLength(0);
  });

  it('lets exactly one prepared or unavailable authority win a mixed CAS race', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');
    const attempt = lastEvent(attempted);
    if (attempt.eventType !== 'student_attempt_submitted') throw new Error('expected attempt');
    const supported = assessmentDeps(h);
    const unsupported = assessmentDeps(h, { schemaVersion: 1, type: 'unsupported' });

    const settled = await Promise.allSettled([
      completeOriginalAttemptAssessment(supported, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        attemptEventId: attempt.eventId,
      }),
      completeOriginalAttemptAssessment(unsupported, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        attemptEventId: attempt.eventId,
      }),
    ]);
    const results = settled.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason;
      return result.value;
    });
    const snapshot = await getCoachProblemState(
      h.deps,
      PROFILE_ID,
      started.snapshot.state.coachSessionId,
    );
    const persisted = events({ snapshot, replayed: false, eventAppended: false });
    const prepared = persisted.filter(
      (event) => event.eventType === 'original_assessment_prepared',
    );
    const unavailable = persisted.filter(
      (event) => event.eventType === 'original_assessment_unavailable',
    );

    expect(prepared.length + unavailable.length).toBe(1);
    if (prepared.length === 1) {
      expect(results.every((result) => result.code === undefined)).toBe(true);
      expect(
        persisted.filter((event) => event.eventType === 'original_attempt_evaluated'),
      ).toHaveLength(1);
      expect(persisted.filter((event) => event.eventType === 'original_resolved')).toHaveLength(1);
    } else {
      expect(results.every((result) => result.code === 'ORIGINAL_ASSESSMENT_UNAVAILABLE')).toBe(
        true,
      );
      expect(
        persisted.filter((event) => event.eventType === 'original_attempt_evaluated'),
      ).toHaveLength(0);
      expect(persisted.filter((event) => event.eventType === 'original_resolved')).toHaveLength(0);
    }
    expect(supported.generationCall).toHaveBeenCalledTimes(1);
    expect(supported.originalAssessmentVerificationCall).toHaveBeenCalledTimes(1);
    expect(unsupported.generationCall).toHaveBeenCalledTimes(2);
    expect(unsupported.originalAssessmentVerificationCall).not.toHaveBeenCalled();
  });
});

describe('unsupported and full-solution semantics', () => {
  it.each([
    {
      label: 'provider failure mixed with unsupported',
      candidateResponses: [
        { schemaVersion: 1, type: 'unsupported' },
        new Error('PRIVATE_ORIGINAL_PROVIDER_DETAIL'),
      ],
      verificationResponses: [JSON.parse(acceptedVerification())],
      code: 'ORIGINAL_ASSESSMENT_GENERATION_FAILED',
      verifierCalls: 0,
    },
    {
      label: 'unsupported after provider failure',
      candidateResponses: [
        new Error('PRIVATE_ORIGINAL_PROVIDER_DETAIL'),
        { schemaVersion: 1, type: 'unsupported' },
      ],
      verificationResponses: [JSON.parse(acceptedVerification())],
      code: 'ORIGINAL_ASSESSMENT_GENERATION_FAILED',
      verifierCalls: 0,
    },
    {
      label: 'invalid candidate mixed with unsupported',
      candidateResponses: [
        { schemaVersion: 1, type: 'unsupported' },
        { schemaVersion: 1, type: 'numeric', expectedNumericValue: '4' },
      ],
      verificationResponses: [JSON.parse(acceptedVerification())],
      code: 'ORIGINAL_ASSESSMENT_INVALID',
      verifierCalls: 0,
    },
    {
      label: 'unsupported after an invalid candidate',
      candidateResponses: [
        { schemaVersion: 1, type: 'numeric', expectedNumericValue: '4' },
        { schemaVersion: 1, type: 'unsupported' },
      ],
      verificationResponses: [JSON.parse(acceptedVerification())],
      code: 'ORIGINAL_ASSESSMENT_INVALID',
      verifierCalls: 0,
    },
    {
      label: 'verifier rejection after unsupported',
      candidateResponses: [
        { schemaVersion: 1, type: 'unsupported' },
        { schemaVersion: 1, type: 'numeric', expectedNumericValue: 4 },
      ],
      verificationResponses: [
        {
          schemaVersion: 1,
          verdict: 'reject',
          checks: {
            objectiveType: true,
            questionConsistent: true,
            answerConsistent: false,
            singleAnswerOrExactSet: true,
            middleSchoolScope: true,
          },
          reasonCode: 'ANSWER_INCONSISTENT',
        },
      ],
      code: 'ORIGINAL_ASSESSMENT_NOT_VERIFIED',
      verifierCalls: 1,
    },
    {
      label: 'unsupported after verifier rejection',
      candidateResponses: [
        { schemaVersion: 1, type: 'numeric', expectedNumericValue: 4 },
        { schemaVersion: 1, type: 'unsupported' },
      ],
      verificationResponses: [
        {
          schemaVersion: 1,
          verdict: 'reject',
          checks: {
            objectiveType: true,
            questionConsistent: true,
            answerConsistent: false,
            singleAnswerOrExactSet: true,
            middleSchoolScope: true,
          },
          reasonCode: 'ANSWER_INCONSISTENT',
        },
      ],
      code: 'ORIGINAL_ASSESSMENT_NOT_VERIFIED',
      verifierCalls: 1,
    },
    {
      label: 'verifier failure after unsupported',
      candidateResponses: [
        { schemaVersion: 1, type: 'unsupported' },
        { schemaVersion: 1, type: 'numeric', expectedNumericValue: 4 },
      ],
      verificationResponses: [new Error('PRIVATE_ORIGINAL_VERIFIER_DETAIL')],
      code: 'ORIGINAL_ASSESSMENT_NOT_VERIFIED',
      verifierCalls: 1,
    },
    {
      label: 'unsupported after verifier failure',
      candidateResponses: [
        { schemaVersion: 1, type: 'numeric', expectedNumericValue: 4 },
        { schemaVersion: 1, type: 'unsupported' },
      ],
      verificationResponses: [new Error('PRIVATE_ORIGINAL_VERIFIER_DETAIL')],
      code: 'ORIGINAL_ASSESSMENT_NOT_VERIFIED',
      verifierCalls: 1,
    },
  ])(
    'keeps $label transient and does not persist unavailability',
    async ({ candidateResponses, verificationResponses, code, verifierCalls }) => {
      const h = harness();
      const started = await start(h);
      const attempted = await submit(h, started, 2, '5');
      const generationCall = modelResponses(...candidateResponses);
      const originalAssessmentVerificationCall = modelResponses(...verificationResponses);

      await expect(
        complete(
          {
            ...h.deps,
            generationCall,
            originalAssessmentVerificationCall,
          },
          attempted,
        ),
      ).rejects.toMatchObject({ code });

      const snapshot = await getCoachProblemState(
        h.deps,
        PROFILE_ID,
        started.snapshot.state.coachSessionId,
      );
      const persisted = events({ snapshot, replayed: false, eventAppended: false });
      expect(snapshot.state.original.assessment).toEqual({ status: 'pending' });
      expect(persisted.map((event) => event.eventType)).toEqual([
        'coach_started',
        'student_attempt_submitted',
      ]);
      expect(
        persisted.filter((event) => event.eventType === 'original_assessment_unavailable'),
      ).toHaveLength(0);
      expect(generationCall).toHaveBeenCalledTimes(2);
      expect(originalAssessmentVerificationCall).toHaveBeenCalledTimes(verifierCalls);

      const recovered = await complete(assessmentDeps(h), attempted);
      const recoveredEvents = events(recovered);
      expect(recovered.snapshot.state.original.assessment.status).toBe('prepared');
      expect(
        recoveredEvents.filter((event) => event.eventType === 'original_assessment_unavailable'),
      ).toHaveLength(0);
      expect(
        recoveredEvents.filter((event) => event.eventType === 'original_attempt_evaluated'),
      ).toHaveLength(1);
    },
  );

  it('accepts a verified supported candidate mixed with unsupported without persisting unavailable', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');
    const generationCall = modelResponses(
      { schemaVersion: 1, type: 'unsupported' },
      { schemaVersion: 1, type: 'numeric', expectedNumericValue: 4 },
    );
    const originalAssessmentVerificationCall = modelResponses(JSON.parse(acceptedVerification()));

    const completed = await complete(
      {
        ...h.deps,
        generationCall,
        originalAssessmentVerificationCall,
      },
      attempted,
    );

    expect(completed.snapshot.state.original.assessment.status).toBe('prepared');
    expect(events(completed).map((event) => event.eventType)).toEqual([
      'coach_started',
      'student_attempt_submitted',
      'original_assessment_prepared',
      'original_attempt_evaluated',
      'original_resolved',
    ]);
    expect(generationCall).toHaveBeenCalledTimes(2);
    expect(originalAssessmentVerificationCall).toHaveBeenCalledTimes(1);
  });

  it('does not turn authoritative incorrect evaluations into correct after a full solution', async () => {
    const h = harness();
    const started = await start(h);
    const firstAttempt = await submit(h, started, 2, '5');
    const first = await complete(assessmentDeps(h), firstAttempt);
    const secondAttempt = await submit(h, first, 3, '6');
    const second = await complete(h.deps, secondAttempt);
    const requested = await requestCoachFullSolution(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: second.snapshot.state.revision,
      message: { seq: 4, text: 'Show the full explanation.' },
    });
    const request = lastEvent(requested);
    if (request.eventType !== 'full_solution_requested') throw new Error('expected request');
    const revealed = await recordFullSolutionRevealed(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: requested.snapshot.state.revision,
      requestEventId: request.eventId,
      explanation: 'Divide both sides by two.',
      finalAnswer: '4',
    });
    const reveal = lastEvent(revealed);
    if (reveal.eventType !== 'full_solution_revealed') throw new Error('expected reveal');
    const resolved = await recordOriginalResolvedFromFullSolution(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: revealed.snapshot.state.revision,
      fullSolutionEventId: reveal.eventId,
    });

    expect(
      events(resolved)
        .filter((event) => event.eventType === 'original_attempt_evaluated')
        .map((event) => event.outcome),
    ).toEqual(['incorrect', 'incorrect']);
    expect(lastEvent(resolved)).not.toHaveProperty('outcome');
    expect(resolved.snapshot.state.original.outcome).toBeUndefined();
    expect(resolved.snapshot.state.original.resolutionKind).toBe('full_solution');
  });

  it('keeps unsupported questions coachable and never invents a full-solution outcome', async () => {
    const h = harness();
    const started = await start(h, 'Explain why this fictional argument is persuasive.');
    const firstAttempt = await submit(h, started, 2, 'A first fictional explanation.');
    const assessment = assessmentDeps(h, { schemaVersion: 1, type: 'unsupported' });

    const unavailable = await complete(assessment, firstAttempt);
    expect(unavailable).toMatchObject({
      replayed: false,
      eventAppended: true,
      code: 'ORIGINAL_ASSESSMENT_UNAVAILABLE',
    });
    expect(lastEvent(unavailable)).toMatchObject({
      eventType: 'original_assessment_unavailable',
      assessmentVersion: 1,
      reason: 'unsupported_question_type',
    });
    const replay = await complete(assessment, firstAttempt);
    expect(replay).toMatchObject({
      replayed: true,
      eventAppended: false,
      code: 'ORIGINAL_ASSESSMENT_UNAVAILABLE',
    });
    expect(assessment.generationCall).toHaveBeenCalledTimes(2);
    expect(assessment.originalAssessmentVerificationCall).not.toHaveBeenCalled();

    const secondAttempt = await submit(h, unavailable, 3, 'A revised fictional explanation.');
    const secondUnavailable = await complete(assessment, secondAttempt);
    expect(secondUnavailable).toMatchObject({
      replayed: true,
      eventAppended: false,
      code: 'ORIGINAL_ASSESSMENT_UNAVAILABLE',
    });
    expect(assessment.generationCall).toHaveBeenCalledTimes(2);
    expect(assessment.originalAssessmentVerificationCall).not.toHaveBeenCalled();
    const requested = await requestCoachFullSolution(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: secondUnavailable.snapshot.state.revision,
      message: { seq: 4, text: 'Show the full explanation.' },
    });
    const request = lastEvent(requested);
    if (request.eventType !== 'full_solution_requested') throw new Error('expected request');
    const revealed = await recordFullSolutionRevealed(h.deps, {
      profileId: PROFILE_ID,
      coachSessionId: started.snapshot.state.coachSessionId,
      expectedRevision: requested.snapshot.state.revision,
      requestEventId: request.eventId,
      explanation: 'A fictional complete explanation.',
      finalAnswer: 'A presentation answer is not an assessment key.',
    });
    const reveal = lastEvent(revealed);
    if (reveal.eventType !== 'full_solution_revealed') throw new Error('expected reveal');
    const resolved = await ensureFullSolutionResolution(h.deps, revealed.snapshot);

    const resolution = lastEvent(resolved);
    expect(resolution).toMatchObject({
      eventType: 'original_resolved',
      resolutionSchemaVersion: 3,
      resolutionKind: 'full_solution',
      fullSolutionEventId: reveal.eventId,
    });
    expect(resolution).not.toHaveProperty('outcome');
    expect(resolved.snapshot.state.original.outcome).toBeUndefined();
    expect(resolved.snapshot.state.original.resolutionKind).toBe('full_solution');
    expect(
      events(resolved).filter((event) => event.eventType === 'original_assessment_unavailable'),
    ).toHaveLength(1);
    expect(
      events(resolved).filter((event) => event.eventType === 'original_assessment_prepared'),
    ).toHaveLength(0);
    expect(
      events(resolved).filter((event) => event.eventType === 'original_attempt_evaluated'),
    ).toHaveLength(0);
  });

  it('rejects an evaluation reference that is not the session assessment or original attempt', async () => {
    const h = harness();
    const started = await start(h);
    const attempted = await submit(h, started, 2, '4');

    await expect(
      recordOriginalAttemptEvaluation(h.deps, {
        profileId: PROFILE_ID,
        coachSessionId: started.snapshot.state.coachSessionId,
        expectedRevision: attempted.snapshot.state.revision,
        assessmentEventId: 'foreign-assessment-event',
        attemptEventId: lastEvent(attempted).eventId,
      }),
    ).rejects.toBeInstanceOf(CoachError);
  });
});
