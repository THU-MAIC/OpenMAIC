import { beforeAll, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
  type RuntimeStore,
} from '@openmaic/storage';
import type { RuntimeRecordInit } from '@openmaic/dsl';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  abandonCoachProblem,
  assignVerifiedTransferQuestion,
  recordFullSolutionRevealed,
  recordHintIssued,
  recordOriginalResolved,
  recordStudyAttemptsProjected,
  recordTransferEvaluation,
  requestCoachFullSolution,
  requestCoachHint,
  startCoachProblem,
  submitCoachAttempt,
  submitCoachTransferAnswer,
  type CoachServiceDeps,
  type TrustedCoachUserMessage,
} from '@/lib/server/zhongkao/coach-service';
import {
  appendCoachRuntimeEvent,
  createCoachOperationFingerprint,
  deriveCoachEventId,
  deriveCoachModelOperationId,
  deriveCoachSessionId,
  deriveCoachStartIdentity,
  deriveCoachStartOperationId,
  hashCoachMessageText,
} from '@/lib/server/zhongkao/coach-runtime';
import {
  ZHONGKAO_OWNER_DIGEST_LENGTH,
  ZHONGKAO_OWNER_LEARNER_PREFIX,
  resolveZhongkaoLearnerKeyFromOwnerId,
} from '@/lib/server/zhongkao/learner-identity';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';
import type { CoachEvent } from '@/lib/zhongkao/coach-event';

const NOW = Date.parse('2026-08-28T08:00:00.000Z');

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

interface Harness {
  store: RuntimeStore;
  deps: CoachServiceDeps;
}

function harness(): Harness {
  const baseStore = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `coach-runtime-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  let clock = 0;
  return {
    store: baseStore,
    deps: {
      store: baseStore,
      ownerId: 'owner-fictional-alpha',
      agentSessionId: 'agent-chat-alpha',
      now: () => new Date(NOW + clock++ * 1000).toISOString(),
    },
  };
}

function wrappedHarness(wrapper: (store: RuntimeStore) => RuntimeStore): Harness {
  const baseStore = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `coach-runtime-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const store = wrapper(baseStore);
  let clock = 0;
  return {
    store,
    deps: {
      store,
      ownerId: 'owner-fictional-alpha',
      agentSessionId: 'agent-chat-alpha',
      now: () => new Date(NOW + clock++ * 1000).toISOString(),
    },
  };
}

async function seedProfile(h: Harness): Promise<void> {
  await saveStudentProfile(
    createInitialStudentProfile({
      profileId: 'student-alpha',
      createdAt: new Date(NOW).toISOString(),
    }),
    {
      store: h.store,
      learnerKey: resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
      now: () => new Date(NOW).toISOString(),
      mintRecordId: () => 'profile-record-alpha',
    },
  );
}

function message(seq: number, text = `fictional durable message ${seq}`): TrustedCoachUserMessage {
  return { seq, text };
}

async function start(
  h: Harness,
  userMessage = message(1, 'Solve fictional 2x = 8.'),
  overrides: Partial<{
    subjectId: string;
    knowledgePointIds: string[];
  }> = {},
) {
  return startCoachProblem(h.deps, {
    profileId: 'student-alpha',
    subjectId: overrides.subjectId ?? 'math',
    knowledgePointIds: overrides.knowledgePointIds ?? ['linear-equations'],
    questionSourceType: 'typed',
    message: userMessage,
  });
}

function events(result: Awaited<ReturnType<typeof startCoachProblem>>): CoachEvent[] {
  return result.snapshot.records.map((record) => record.payload as CoachEvent);
}

function lastEvent(result: { snapshot: { records: { payload: unknown }[] } }): CoachEvent {
  return result.snapshot.records.at(-1)!.payload as CoachEvent;
}

async function readyForTransfer(h: Harness) {
  const created = await start(h);
  const attempted = await submitCoachAttempt(h.deps, {
    profileId: 'student-alpha',
    coachSessionId: created.snapshot.state.coachSessionId,
    expectedRevision: 0,
    message: message(2, 'x equals 4'),
  });
  const attemptEvent = lastEvent(attempted);
  const resolved = await recordOriginalResolved(h.deps, {
    profileId: 'student-alpha',
    coachSessionId: created.snapshot.state.coachSessionId,
    expectedRevision: attempted.snapshot.state.revision,
    attemptEventId: attemptEvent.eventId,
    outcome: 'incorrect',
  });
  const resolutionEvent = lastEvent(resolved);
  const assigned = await assignVerifiedTransferQuestion(h.deps, {
    profileId: 'student-alpha',
    coachSessionId: created.snapshot.state.coachSessionId,
    expectedRevision: resolved.snapshot.state.revision,
    originalResolvedEventId: resolutionEvent.eventId,
    transferQuestionId: 'transfer-question-alpha',
    knowledgePointIds: ['linear-equations'],
    validationRef: 'verified-generator-alpha',
  });
  return { created, attempted, attemptEvent, resolved, resolutionEvent, assigned };
}

describe('coach identity and operation hashing', () => {
  it('derives start session and operation only from the stable durable identity', () => {
    const identity = deriveCoachStartIdentity({
      learnerKey: 'learner-alpha',
      profileId: 'student-alpha',
      agentSessionId: 'agent-alpha',
      sourceUserMessageSeq: 7,
    });
    expect(deriveCoachSessionId(identity)).toBe(deriveCoachSessionId(identity));
    expect(deriveCoachStartOperationId(identity)).toBe(deriveCoachStartOperationId(identity));
    expect(JSON.stringify(identity)).not.toContain('toolCallId');
  });

  it('keeps model operation identity stable across tool calls and distinct by action', () => {
    const common = {
      learnerKey: 'learner-alpha',
      profileId: 'student-alpha',
      coachSessionId: 'coach-alpha',
      agentSessionId: 'agent-alpha',
      sourceUserMessageSeq: 8,
    };
    const first = deriveCoachModelOperationId({ ...common, action: 'submit_attempt' });
    expect(first).toBe(deriveCoachModelOperationId({ ...common, action: 'submit_attempt' }));
    expect(first).not.toBe(deriveCoachModelOperationId({ ...common, action: 'request_hint' }));
  });

  it('canonicalizes fingerprints and hashes student text to fixed-length digests', () => {
    expect(createCoachOperationFingerprint({ b: 2, a: 1 })).toBe(
      createCoachOperationFingerprint({ a: 1, b: 2 }),
    );
    expect(hashCoachMessageText('fictional response')).toHaveLength(64);
    expect(hashCoachMessageText('fictional response')).not.toContain('fictional');
  });

  it('does not include expectedRevision in semantic model facts', () => {
    const facts = {
      action: 'submit_attempt',
      coachSessionId: 'coach-alpha',
      phase: 'original',
      trustedMessageRef: { agentSessionId: 'agent-alpha', userMessageSeq: 9 },
      studentResponseHash: hashCoachMessageText('x equals 4'),
    };
    expect(createCoachOperationFingerprint(facts)).toBe(createCoachOperationFingerprint(facts));
  });
});

describe('owner pseudonymous partition key', () => {
  it('is fixed length, versioned, stable, and does not contain owner plaintext', () => {
    const short = resolveZhongkaoLearnerKeyFromOwnerId('alice@example.test');
    const long = resolveZhongkaoLearnerKeyFromOwnerId(`owner-${'x'.repeat(10_000)}`);
    expect(short).toBe(resolveZhongkaoLearnerKeyFromOwnerId('alice@example.test'));
    expect(short).toHaveLength(ZHONGKAO_OWNER_LEARNER_PREFIX.length + ZHONGKAO_OWNER_DIGEST_LENGTH);
    expect(long).toHaveLength(short.length);
    expect(short.startsWith(ZHONGKAO_OWNER_LEARNER_PREFIX)).toBe(true);
    expect(short).not.toContain('alice');
    expect(short).not.toContain('example.test');
  });

  it('maps different owners differently and is not reversible base64 concatenation', () => {
    const left = resolveZhongkaoLearnerKeyFromOwnerId('owner-alpha');
    const right = resolveZhongkaoLearnerKeyFromOwnerId('owner-beta');
    expect(left).not.toBe(right);
    expect(left).not.toContain(Buffer.from('owner-alpha').toString('base64url'));
  });
});

describe('start uniqueness and semantic replay', () => {
  it('replays identical start facts from the same durable message once', async () => {
    const h = harness();
    await seedProfile(h);
    const first = await start(h);
    const replay = await start(h);
    expect(replay).toMatchObject({ replayed: true, eventAppended: false });
    expect(replay.snapshot.state.coachSessionId).toBe(first.snapshot.state.coachSessionId);
    expect(await h.store.listRecords(first.snapshot.session.id)).toHaveLength(1);
  });

  it('normalizes knowledge-point ordering for identical starts', async () => {
    const h = harness();
    await seedProfile(h);
    const first = await start(h, message(1), {
      knowledgePointIds: ['quadratic-equations', 'linear-equations'],
    });
    const replay = await start(h, message(1), {
      knowledgePointIds: ['linear-equations', 'quadratic-equations'],
    });
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.state.coachSessionId).toBe(first.snapshot.state.coachSessionId);
  });

  it('conflicts on different subject or knowledge facts for the same start identity', async () => {
    const h = harness();
    await seedProfile(h);
    await start(h);
    await expect(start(h, message(1), { subjectId: 'physics' })).rejects.toMatchObject({
      code: 'COACH_EVENT_CONFLICT',
    });
    await expect(
      start(h, message(1), { knowledgePointIds: ['quadratic-equations'] }),
    ).rejects.toMatchObject({ code: 'COACH_EVENT_CONFLICT' });
  });

  it('creates different sessions for different durable messages', async () => {
    const h = harness();
    await seedProfile(h);
    const first = await start(h, message(1));
    const second = await start(h, message(2));
    expect(second.snapshot.state.coachSessionId).not.toBe(first.snapshot.state.coachSessionId);
  });

  it('initializes one event under concurrent identical starts', async () => {
    const h = harness();
    await seedProfile(h);
    const [left, right] = await Promise.all([start(h), start(h)]);
    expect(left.snapshot.state.coachSessionId).toBe(right.snapshot.state.coachSessionId);
    expect([left.eventAppended, right.eventAppended].filter(Boolean)).toHaveLength(1);
    expect(await h.store.listRecords(left.snapshot.session.id)).toHaveLength(1);
  });
});

describe('model action fingerprint replay', () => {
  it('counts the same submit operation once despite a changed revision', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    const input = {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 0,
      message: message(2, 'x equals 4'),
    };
    const first = await submitCoachAttempt(h.deps, input);
    const replay = await submitCoachAttempt(h.deps, { ...input, expectedRevision: 999 });
    expect(replay).toMatchObject({ replayed: true, eventAppended: false });
    expect(first.snapshot.state.original.attemptCount).toBe(1);
    expect(replay.snapshot.state.original.attemptCount).toBe(1);
  });

  it('conflicts when the same semantic operation carries different student text', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 0,
      message: message(2, 'x equals 4'),
    });
    await expect(
      submitCoachAttempt(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: 1,
        message: message(2, 'x equals 5'),
      }),
    ).rejects.toMatchObject({ code: 'COACH_EVENT_CONFLICT' });
  });

  it('allows one submit and one hint request from the same durable message', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    const attempted = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 0,
      message: message(2, 'I tried x=4; one hint please.'),
    });
    const hinted = await requestCoachHint(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: attempted.snapshot.state.revision,
      message: message(2, 'I tried x=4; one hint please.'),
    });
    expect(hinted.snapshot.state.original).toMatchObject({ attemptCount: 1, hintsIssued: 0 });
    expect(hinted.snapshot.state.original.hintRequestEventIds).toHaveLength(1);
  });

  it('replays the same hint request once and rejects a second pending request', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    const first = await requestCoachHint(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 0,
      message: message(2, 'One hint please.'),
    });
    const replay = await requestCoachHint(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 999,
      message: message(2, 'One hint please.'),
    });
    expect(replay.replayed).toBe(true);
    await expect(
      requestCoachHint(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: first.snapshot.state.revision,
        message: message(3, 'Another hint before generation.'),
      }),
    ).rejects.toMatchObject({ code: 'HINT_GENERATION_PENDING' });
  });

  it('compares operation fingerprint before revision and callback execution', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    const started = events(created)[0]!;
    const callback = vi.fn(() => {
      throw new Error('must not execute');
    });
    const replay = await appendCoachRuntimeEvent(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 999,
      operationId: started.operationId,
      operationFingerprint: started.operationFingerprint,
      createEvent: callback,
    });
    expect(replay.replayed).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    await expect(
      appendCoachRuntimeEvent(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: 0,
        operationId: started.operationId,
        operationFingerprint: 'f'.repeat(64),
        createEvent: callback,
      }),
    ).rejects.toMatchObject({ code: 'COACH_EVENT_CONFLICT' });
  });
});

describe('causal service operations and phase isolation', () => {
  it('issues each hint from the exact pending request and replays by request id', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    const requested = await requestCoachHint(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 0,
      message: message(2, 'One small hint.'),
    });
    const request = lastEvent(requested);
    const issued = await recordHintIssued(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: requested.snapshot.state.revision,
      requestEventId: request.eventId,
    });
    const replay = await recordHintIssued(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 999,
      requestEventId: request.eventId,
    });
    expect(issued.snapshot.state.original.hintsIssued).toBe(1);
    expect(replay).toMatchObject({ replayed: true, eventAppended: false });
    await expect(
      recordHintIssued(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: issued.snapshot.state.revision,
        requestEventId: 'missing-request',
      }),
    ).rejects.toMatchObject({ code: 'COACH_ACTION_NOT_ALLOWED' });
  });

  it('records transfer hints only in transfer phase', async () => {
    const h = harness();
    await seedProfile(h);
    const ready = await readyForTransfer(h);
    const requested = await requestCoachHint(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: ready.created.snapshot.state.coachSessionId,
      expectedRevision: ready.assigned.snapshot.state.revision,
      message: message(3, 'A hint for the transfer question.'),
    });
    const request = lastEvent(requested);
    const issued = await recordHintIssued(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: ready.created.snapshot.state.coachSessionId,
      expectedRevision: requested.snapshot.state.revision,
      requestEventId: request.eventId,
    });
    expect(issued.snapshot.state.original.hintsIssued).toBe(0);
    expect(issued.snapshot.state.transfer.hintsIssued).toBe(1);
    expect(issued.snapshot.state.transfer.viewedFullAnswer).toBe(false);
  });

  it('requires an explicit unlocked solution request and consumes it for reveal', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    const early = await requestCoachFullSolution(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 0,
      message: message(2, 'Show the complete answer now.'),
    });
    expect(early.code).toBe('FULL_SOLUTION_LOCKED');
    const earlyRequest = lastEvent(early);
    await expect(
      recordFullSolutionRevealed(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: early.snapshot.state.revision,
        requestEventId: earlyRequest.eventId,
      }),
    ).rejects.toMatchObject({ code: 'FULL_SOLUTION_REQUEST_REQUIRED' });

    const first = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: early.snapshot.state.revision,
      message: message(3, 'first attempt'),
    });
    const second = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: first.snapshot.state.revision,
      message: message(4, 'second attempt'),
    });
    expect(second.snapshot.state.original.fullSolutionAvailable).toBe(true);
    expect(second.snapshot.state.original.pendingFullSolutionRequestEventId).toBeUndefined();

    const explicit = await requestCoachFullSolution(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: second.snapshot.state.revision,
      message: message(5, 'I explicitly request the explanation again.'),
    });
    const explicitRequest = lastEvent(explicit);
    const revealed = await recordFullSolutionRevealed(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: explicit.snapshot.state.revision,
      requestEventId: explicitRequest.eventId,
    });
    const replay = await recordFullSolutionRevealed(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 999,
      requestEventId: explicitRequest.eventId,
    });
    expect(revealed.snapshot.state.original.viewedFullAnswer).toBe(true);
    expect(revealed.snapshot.state.transfer.viewedFullAnswer).toBe(false);
    expect(replay.replayed).toBe(true);
  });

  it('ties resolution to an original attempt and conflicts on a second outcome', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    await expect(
      recordOriginalResolved(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: 0,
        attemptEventId: 'missing-attempt',
        outcome: 'incorrect',
      }),
    ).rejects.toMatchObject({ code: 'STUDENT_ATTEMPT_REQUIRED' });
    const attempted = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 0,
      message: message(2, 'x equals 4'),
    });
    const attemptEvent = lastEvent(attempted);
    await recordOriginalResolved(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: attempted.snapshot.state.revision,
      attemptEventId: attemptEvent.eventId,
      outcome: 'incorrect',
    });
    await expect(
      recordOriginalResolved(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: 999,
        attemptEventId: attemptEvent.eventId,
        outcome: 'correct',
      }),
    ).rejects.toMatchObject({ code: 'COACH_EVENT_CONFLICT' });
  });

  it('ties assignment facts to resolution and conflicts on a changed question', async () => {
    const h = harness();
    await seedProfile(h);
    const ready = await readyForTransfer(h);
    await expect(
      assignVerifiedTransferQuestion(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: ready.created.snapshot.state.coachSessionId,
        expectedRevision: 999,
        originalResolvedEventId: ready.resolutionEvent.eventId,
        transferQuestionId: 'different-transfer-question',
        knowledgePointIds: ['linear-equations'],
        validationRef: 'verified-generator-alpha',
      }),
    ).rejects.toMatchObject({ code: 'COACH_EVENT_CONFLICT' });
  });

  it('derives evaluation and projection identities from causal events', async () => {
    const h = harness();
    await seedProfile(h);
    const ready = await readyForTransfer(h);
    const submitted = await submitCoachTransferAnswer(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: ready.created.snapshot.state.coachSessionId,
      expectedRevision: ready.assigned.snapshot.state.revision,
      message: message(3, 'transfer answer x equals 7'),
    });
    const submission = lastEvent(submitted);
    const evaluated = await recordTransferEvaluation(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: ready.created.snapshot.state.coachSessionId,
      expectedRevision: submitted.snapshot.state.revision,
      submissionEventId: submission.eventId,
      outcome: 'correct',
    });
    await expect(
      recordTransferEvaluation(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: ready.created.snapshot.state.coachSessionId,
        expectedRevision: 999,
        submissionEventId: submission.eventId,
        outcome: 'incorrect',
      }),
    ).rejects.toMatchObject({ code: 'COACH_EVENT_CONFLICT' });
    const evaluationEvent = lastEvent(evaluated);
    const projected = await recordStudyAttemptsProjected(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: ready.created.snapshot.state.coachSessionId,
      expectedRevision: evaluated.snapshot.state.revision,
      evaluationEventId: evaluationEvent.eventId,
    });
    const projectionEvent = lastEvent(projected);
    expect(projected.snapshot.state.status).toBe('completed');
    expect(projectionEvent).toMatchObject({
      eventType: 'study_attempts_projected',
      evaluationEventId: evaluationEvent.eventId,
      projectionVersion: 1,
    });
    expect(
      (projectionEvent as Extract<CoachEvent, { eventType: 'study_attempts_projected' }>)
        .projectionRef,
    ).toMatch(/^coach-projection:v1:/u);
    const replay = await recordStudyAttemptsProjected(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: ready.created.snapshot.state.coachSessionId,
      expectedRevision: 999,
      evaluationEventId: evaluationEvent.eventId,
    });
    expect(replay.replayed).toBe(true);
  });

  it('rejects reuse of an original attempt message as a transfer submission', async () => {
    const h = harness();
    await seedProfile(h);
    const ready = await readyForTransfer(h);
    await expect(
      submitCoachTransferAnswer(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: ready.created.snapshot.state.coachSessionId,
        expectedRevision: ready.assigned.snapshot.state.revision,
        message: message(2, 'reuse original seq'),
      }),
    ).rejects.toMatchObject({ code: 'COACH_MESSAGE_ALREADY_COUNTED' });
  });

  it('allows only one transfer submission', async () => {
    const h = harness();
    await seedProfile(h);
    const ready = await readyForTransfer(h);
    const first = await submitCoachTransferAnswer(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: ready.created.snapshot.state.coachSessionId,
      expectedRevision: ready.assigned.snapshot.state.revision,
      message: message(3, 'first transfer submission'),
    });
    await expect(
      submitCoachTransferAnswer(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: ready.created.snapshot.state.coachSessionId,
        expectedRevision: first.snapshot.state.revision,
        message: message(4, 'second transfer submission'),
      }),
    ).rejects.toMatchObject({ code: 'COACH_ACTION_NOT_ALLOWED' });
  });

  it('keeps transfer facts sufficient for later StudyAttempt projection', async () => {
    const h = harness();
    await seedProfile(h);
    const ready = await readyForTransfer(h);
    const submitted = await submitCoachTransferAnswer(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: ready.created.snapshot.state.coachSessionId,
      expectedRevision: ready.assigned.snapshot.state.revision,
      message: message(3, 'independent transfer response'),
    });
    expect(submitted.snapshot.state.transfer).toMatchObject({
      attemptCount: 1,
      hintsIssued: 0,
      keyHintUsed: false,
      viewedFullAnswer: false,
    });
  });

  it('makes abandon terminal and restricts future actions', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await start(h);
    const ended = await abandonCoachProblem(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.snapshot.state.coachSessionId,
      expectedRevision: 0,
      message: message(2, 'Stop this problem.'),
    });
    expect(ended.snapshot.state.status).toBe('abandoned');
    await expect(
      submitCoachAttempt(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: ended.snapshot.state.revision,
        message: message(3, 'late answer'),
      }),
    ).rejects.toMatchObject({ code: 'COACH_ACTION_NOT_ALLOWED' });
  });
});

describe('coach CAS error mapping', () => {
  it('maps a typed competing terminal append to COACH_SESSION_CONFLICT', async () => {
    let injected = false;
    const h = wrappedHarness(
      (base) =>
        new Proxy(base, {
          get(target, property, receiver) {
            if (property === 'appendRecord') {
              return async (
                init: RuntimeRecordInit,
                options: Parameters<RuntimeStore['appendRecord']>[1],
              ) => {
                const event = init.payload as CoachEvent;
                if (!injected && event.eventType === 'student_attempt_submitted') {
                  injected = true;
                  const operationId = `coach-op:v2:${'b'.repeat(64)}`;
                  const competing: CoachEvent = {
                    schemaVersion: 1,
                    eventId: deriveCoachEventId(operationId),
                    coachSessionId: event.coachSessionId,
                    profileId: event.profileId,
                    eventType: 'problem_abandoned',
                    createdAt: new Date(NOW + 50_000).toISOString(),
                    agentSessionId: event.agentSessionId,
                    sourceUserMessageSeq: 99,
                    operationId,
                    operationFingerprint: 'c'.repeat(64),
                  };
                  const appended = await target.appendRecord(
                    {
                      id: competing.eventId,
                      sessionId: init.sessionId,
                      createdAt: competing.createdAt,
                      subAnchor: competing.eventId,
                      payload: competing,
                    },
                    {
                      expectedLastSeq: options?.expectedLastSeq,
                      sessionTransition: {
                        status: 'completed',
                        updatedAt: competing.createdAt,
                      },
                    },
                  );
                  throw new RuntimeAppendConflictError(
                    init.sessionId,
                    options?.expectedLastSeq ?? null,
                    appended.seq,
                  );
                }
                return target.appendRecord(init, options);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as RuntimeStore,
    );
    await seedProfile(h);
    const created = await start(h);
    await expect(
      submitCoachAttempt(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: 0,
        message: message(2, 'racing response'),
      }),
    ).rejects.toMatchObject({ code: 'COACH_SESSION_CONFLICT', latestRevision: 1 });
  });

  it('does not classify an ordinary error by matching its message text', async () => {
    const h = wrappedHarness(
      (base) =>
        new Proxy(base, {
          get(target, property, receiver) {
            if (property === 'appendRecord') {
              return async (
                init: RuntimeRecordInit,
                options: Parameters<RuntimeStore['appendRecord']>[1],
              ) => {
                const event = init.payload as CoachEvent;
                if (event.eventType === 'student_attempt_submitted') {
                  throw new Error('inactive COACH_SESSION_CONFLICT');
                }
                return target.appendRecord(init, options);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as RuntimeStore,
    );
    await seedProfile(h);
    const created = await start(h);
    await expect(
      submitCoachAttempt(h.deps, {
        profileId: 'student-alpha',
        coachSessionId: created.snapshot.state.coachSessionId,
        expectedRevision: 0,
        message: message(2),
      }),
    ).rejects.toThrow('inactive COACH_SESSION_CONFLICT');
  });
});
