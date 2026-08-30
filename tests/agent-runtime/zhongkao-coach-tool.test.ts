import { readFileSync } from 'node:fs';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AICallFn } from '@openmaic/generation';
import {
  BrowserRuntimeStore,
  RuntimeAppendConflictError,
  type RuntimeStore,
} from '@openmaic/storage';
import type { RuntimeRecordInit } from '@openmaic/dsl';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Check } from 'typebox/value';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  ZHONGKAO_COACH_ACTION_SCHEMA,
  ZHONGKAO_COACH_OUTPUT_SCHEMA,
  buildCoachToolErrorOutput,
  createAgentSessionCoachMessageReader,
  createZhongkaoCoachActionTool,
  type TrustedAgentTurn,
  type ZhongkaoCoachToolOutput,
} from '@/lib/server/agent-runtime/zhongkao-coach-tool';
import {
  assignVerifiedTransferQuestion,
  recordFullSolutionRevealed,
  recordOriginalResolved,
  requestCoachFullSolution,
  submitCoachAttempt,
  submitCoachTransferAnswer,
  type CoachServiceDeps,
} from '@/lib/server/zhongkao/coach-service';
import type { ZhongkaoMaterialSourceAdapter } from '@/lib/server/agent-runtime/zhongkao-material-source';
import { deriveCoachEventId } from '@/lib/server/zhongkao/coach-runtime';
import { deriveTransferQuestionId } from '@/lib/server/zhongkao/transfer-assignment';
import type { VerifiedTransferQuestion } from '@/lib/server/zhongkao/transfer-question-private';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import type { CoachEvent } from '@/lib/zhongkao/coach-event';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { CoachError } from '@/lib/zhongkao/coach-errors';
import type { CurriculumSourceVerifier } from '@/lib/zhongkao/curriculum';
import { saveStudentProfile, zhongkaoStageId } from '@/lib/zhongkao/runtime';

const NOW = Date.parse('2026-08-28T08:00:00.000Z');

beforeAll(() => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});

interface ToolHarness {
  store: RuntimeStore;
  deps: CoachServiceDeps;
  now: () => string;
}

function harness(): ToolHarness {
  const store = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `coach-tool-${Math.random()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  let clock = 0;
  const now = () => new Date(NOW + clock++ * 1000).toISOString();
  return {
    store,
    now,
    deps: {
      store,
      ownerId: 'owner-fictional-alpha',
      agentSessionId: 'agent-chat-alpha',
      now,
    },
  };
}

async function seedProfile(h: ToolHarness): Promise<void> {
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

function toolFor(
  h: ToolHarness,
  seq: number,
  text: string,
  options: {
    turn?: TrustedAgentTurn;
    reader?: () => Promise<{ seq: number; text: string }>;
    createGenerationCall?: (signal?: AbortSignal) => AICallFn;
    createTransferVerificationCall?: (signal?: AbortSignal) => AICallFn;
    generationCall?: AICallFn;
    transferVerificationCall?: AICallFn;
    materialSource?: ZhongkaoMaterialSourceAdapter;
    runtimeStore?: RuntimeStore;
    beforeExecute?: () => Promise<void>;
  } = {},
): AgentTool<never, never> {
  const generationCall =
    options.generationCall ??
    (async (systemPrompt) =>
      systemPrompt.includes('full-solution')
        ? JSON.stringify({
            schemaVersion: 1,
            explanation: 'Use inverse operations to isolate the unknown.',
            finalAnswer: 'x = 4',
            claims: [],
          })
        : JSON.stringify({ schemaVersion: 1, hint: 'Recall the inverse operation.' }));
  return createZhongkaoCoachActionTool({
    trustedTurn:
      options.turn ??
      ({
        ownerId: h.deps.ownerId,
        agentSessionId: h.deps.agentSessionId,
        userMessageSeq: seq,
      } satisfies TrustedAgentTurn),
    runtimeStore: options.runtimeStore ?? h.store,
    readTrustedUserMessage: options.reader ?? (async () => ({ seq, text })),
    createGenerationCall: options.createGenerationCall ?? (() => generationCall),
    ...(options.createTransferVerificationCall
      ? { createTransferVerificationCall: options.createTransferVerificationCall }
      : {}),
    ...(options.transferVerificationCall
      ? { transferVerificationCall: options.transferVerificationCall }
      : {}),
    ...(options.materialSource ? { materialSource: options.materialSource } : {}),
    ...(options.beforeExecute ? { beforeExecute: options.beforeExecute } : {}),
    now: h.now,
  });
}

async function execute(
  tool: AgentTool<never, never>,
  toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ output: ZhongkaoCoachToolOutput; raw: unknown }> {
  const raw = await (
    tool.execute as (
      id: string,
      value: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>
  )(toolCallId, params, signal);
  return {
    output: (raw as { details: ZhongkaoCoachToolOutput }).details,
    raw,
  };
}

const START_INPUT = {
  action: 'start_problem',
  profileId: 'student-alpha',
  subjectId: 'math',
  knowledgePointIds: ['linear-equations'],
  questionSourceType: 'typed',
} as const;

function verifiedTransferQuestion(
  coachSessionId: string,
  originalResolvedEventId: string,
): VerifiedTransferQuestion {
  return {
    validationStatus: 'verified',
    validationRef: `transfer-validation:v1:${'b'.repeat(64)}`,
    publicQuestion: {
      schemaVersion: 1,
      transferQuestionId: deriveTransferQuestionId({ coachSessionId, originalResolvedEventId }),
      type: 'exact_short_answer',
      question: 'Write the exact fictional transfer answer.',
      knowledgePointIds: ['linear-equations'],
      difficulty: 'same',
    },
    gradingSpec: {
      schemaVersion: 1,
      type: 'exact_short_answer',
      acceptedAnswers: ['fictional transfer answer'],
      caseMode: 'case_sensitive',
    },
    verification: {
      schemaVersion: 1,
      status: 'verified',
      candidateFingerprint: 'a'.repeat(64),
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

describe('Zhongkao coach TypeBox input boundary', () => {
  it('accepts exactly the seven model actions', () => {
    expect(Check(ZHONGKAO_COACH_ACTION_SCHEMA, START_INPUT)).toBe(true);
    for (const action of [
      'get_state',
      'submit_attempt',
      'request_hint',
      'request_full_solution',
      'submit_transfer_answer',
      'abandon_problem',
    ]) {
      expect(
        Check(ZHONGKAO_COACH_ACTION_SCHEMA, {
          action,
          profileId: 'student-alpha',
          coachSessionId: 'coach-alpha',
          ...(action === 'get_state' ? {} : { expectedRevision: 0 }),
        }),
      ).toBe(true);
    }
  });

  it.each([
    'recordHintIssued',
    'recordFullSolutionRevealed',
    'recordOriginalResolved',
    'assignVerifiedTransferQuestion',
    'recordTransferEvaluation',
    'recordStudyAttemptsProjected',
  ])('does not expose internal action %s', (action) => {
    expect(Check(ZHONGKAO_COACH_ACTION_SCHEMA, { ...START_INPUT, action })).toBe(false);
  });

  it.each([
    'phase',
    'studentResponse',
    'questionText',
    'ownerId',
    'learnerKey',
    'currentUserMessageSeq',
    'currentUserMessageId',
    'toolCallId',
    'operationId',
    'operationFingerprint',
    'eventId',
    'requestEventId',
    'attemptEventId',
    'submissionEventId',
    'evaluationEventId',
    'outcome',
    'correct',
    'gradingSpec',
    'expectedAnswer',
    'createdAt',
    'answerUnlocked',
    'viewedFullAnswer',
    'isIndependent',
    'mastered',
    'verifiedSource',
    'sourcePage',
  ])('rejects model-supplied trust field %s', (field) => {
    expect(Check(ZHONGKAO_COACH_ACTION_SCHEMA, { ...START_INPUT, [field]: 'forged' })).toBe(false);
  });

  it('requires a non-negative integer continuation revision', () => {
    const input = {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: 'coach-alpha',
    };
    expect(Check(ZHONGKAO_COACH_ACTION_SCHEMA, input)).toBe(false);
    expect(Check(ZHONGKAO_COACH_ACTION_SCHEMA, { ...input, expectedRevision: -1 })).toBe(false);
    expect(Check(ZHONGKAO_COACH_ACTION_SCHEMA, { ...input, expectedRevision: 1.5 })).toBe(false);
  });

  it('accepts only a materialId for a material source and rejects it on typed input', () => {
    expect(
      Check(ZHONGKAO_COACH_ACTION_SCHEMA, {
        ...START_INPUT,
        questionSourceType: 'material',
        materialId: 'mat_alpha',
      }),
    ).toBe(true);
    expect(Check(ZHONGKAO_COACH_ACTION_SCHEMA, { ...START_INPUT, materialId: 'mat_alpha' })).toBe(
      false,
    );
  });
});

describe('Zhongkao coach durable execution barrier', () => {
  it('awaits the server barrier before reading the trusted turn or touching runtime state', async () => {
    const h = harness();
    const reader = vi.fn(async () => ({ seq: 1, text: '不应读取' }));
    const beforeExecute = vi.fn(async () => {
      throw new Error('ENTRY_APPEND_FAILED');
    });
    const tool = toolFor(h, 1, '不应读取', { reader, beforeExecute });

    const result = await execute(tool, 'barrier-call', START_INPUT);

    expect(beforeExecute).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({
      ok: false,
      code: 'COACH_RUNTIME_UNAVAILABLE',
      facts: { replayed: false, eventAppended: false },
    });
    expect(
      await h.store.listSessions(
        zhongkaoStageId('student-alpha'),
        resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
      ),
    ).toHaveLength(0);
  });
});

describe('immutable trusted Agent turn reader', () => {
  function fakeStore(
    ownerId = 'owner-fictional-alpha',
    events: Array<{ id: number; type: string; text: string }> = [
      { id: 7, type: 'user_message', text: 'Trusted fictional response' },
      { id: 8, type: 'user_message', text: 'Later durable response' },
    ],
  ) {
    return {
      getSession: vi.fn(async (id: string) => ({
        id,
        ownerId,
        prompt: 'fictional',
        stageId: 'agent-stage',
        existingCourse: false,
        status: 'running' as const,
        attempt: 1,
        deliveredUserMessageSeq: 0,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      readEventsAfter: vi.fn(async (_sessionId: string, afterSeq: number) =>
        afterSeq === 0
          ? events.map((event) => ({
              id: event.id,
              ts: NOW,
              attempt: 1,
              type: event.type,
              data: { text: event.text, delivery: 'queued', materials: [] },
            }))
          : [],
      ),
      listUserMessages: vi.fn(async () => []),
    };
  }

  function turn(overrides: Partial<TrustedAgentTurn> = {}): TrustedAgentTurn {
    return {
      ownerId: 'owner-fictional-alpha',
      agentSessionId: 'agent-chat-alpha',
      userMessageSeq: 7,
      ...overrides,
    };
  }

  it('reads only the exact persisted user message, not the latest one', async () => {
    const store = fakeStore();
    const reader = createAgentSessionCoachMessageReader({
      store: store as never,
      trustedTurn: turn(),
    });
    await expect(reader()).resolves.toEqual({ seq: 7, text: 'Trusted fictional response' });
    expect(store.readEventsAfter).toHaveBeenCalled();
  });

  it('captures a copy before the caller mutates the turn object', async () => {
    const mutable = turn();
    const reader = createAgentSessionCoachMessageReader({
      store: fakeStore() as never,
      trustedTurn: mutable,
    });
    mutable.ownerId = 'owner-fictional-beta';
    mutable.agentSessionId = 'agent-chat-beta';
    mutable.userMessageSeq = 8;
    await expect(reader()).resolves.toEqual({ seq: 7, text: 'Trusted fictional response' });
  });

  it('rejects owner, session, exact seq, role, blank text, and oversized text mismatches', async () => {
    const cases = [
      { store: fakeStore('owner-fictional-beta'), trustedTurn: turn() },
      { store: fakeStore(), trustedTurn: turn({ userMessageSeq: 9 }) },
      {
        store: fakeStore('owner-fictional-alpha', [
          { id: 7, type: 'assistant_message', text: 'not a user message' },
        ]),
        trustedTurn: turn(),
      },
      {
        store: fakeStore('owner-fictional-alpha', [{ id: 7, type: 'user_message', text: '   ' }]),
        trustedTurn: turn(),
      },
      {
        store: fakeStore('owner-fictional-alpha', [
          { id: 7, type: 'user_message', text: 'x'.repeat(12_001) },
        ]),
        trustedTurn: turn(),
      },
    ];
    for (const input of cases) {
      const reader = createAgentSessionCoachMessageReader({
        store: input.store as never,
        trustedTurn: input.trustedTurn,
      });
      await expect(reader()).rejects.toMatchObject({ code: 'COACH_INPUT_INVALID' });
    }
  });
});

describe('Zhongkao coach immutable tool execution', () => {
  it('returns a runtime-validated safe error when the profile is absent', async () => {
    const h = harness();
    const { output } = await execute(toolFor(h, 1, 'fictional question'), 'call-a', START_INPUT);
    expect(output).toMatchObject({ ok: false, code: 'COACH_PROFILE_NOT_FOUND' });
    expect(Check(ZHONGKAO_COACH_OUTPUT_SCHEMA, output)).toBe(true);
    expect(Check(ZHONGKAO_COACH_OUTPUT_SCHEMA, buildCoachToolErrorOutput(new Error('raw')))).toBe(
      true,
    );
  });

  it('captures the factory turn even when the source object is mutated later', async () => {
    const h = harness();
    await seedProfile(h);
    const mutable: TrustedAgentTurn = {
      ownerId: h.deps.ownerId,
      agentSessionId: h.deps.agentSessionId,
      userMessageSeq: 1,
    };
    const tool = toolFor(h, 1, 'Trusted original question.', { turn: mutable });
    mutable.ownerId = 'foreign-owner';
    mutable.agentSessionId = 'foreign-session';
    mutable.userMessageSeq = 99;
    const { output } = await execute(tool, 'call-a', START_INPUT);
    expect(output.ok).toBe(true);
  });

  it('rejects a reader result that does not match the frozen seq', async () => {
    const h = harness();
    await seedProfile(h);
    const tool = toolFor(h, 7, 'bound', {
      reader: async () => ({ seq: 8, text: 'later message' }),
    });
    const { output } = await execute(tool, 'call-a', START_INPUT);
    expect(output).toMatchObject({ ok: false, code: 'COACH_INPUT_INVALID' });
  });

  it('ignores toolCallId for identical start identity and writes one event', async () => {
    const h = harness();
    await seedProfile(h);
    const tool = toolFor(h, 1, 'Solve trusted fictional 2x = 8.');
    const first = await execute(tool, 'tool-call-one', START_INPUT);
    const replay = await execute(tool, 'tool-call-two', START_INPUT);
    expect(replay.output).toMatchObject({
      ok: true,
      coachSessionId: first.output.coachSessionId,
      facts: { replayed: true, eventAppended: false },
    });
    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((session) => session.kind === 'zhongkaoCoachEvent')!;
    expect(await h.store.listRecords(coach.id)).toHaveLength(1);
  });

  it('returns a stable conflict for different start facts on the same durable turn', async () => {
    const h = harness();
    await seedProfile(h);
    const tool = toolFor(h, 1, 'Solve trusted fictional 2x = 8.');
    await execute(tool, 'tool-call-one', START_INPUT);
    const { output } = await execute(tool, 'tool-call-two', {
      ...START_INPUT,
      subjectId: 'physics',
    });
    expect(output).toMatchObject({ ok: false, code: 'COACH_EVENT_CONFLICT' });
  });

  it('replays one submit and keeps the private assessment alternative out of the public DTO', async () => {
    const h = harness();
    await seedProfile(h);
    const privateCanary = 'PRIVATE_ORIGINAL_SPEC_ALTERNATIVE_7G4Q';
    const created = await execute(
      toolFor(h, 1, 'Give the exact fictional phrase requested by this test.'),
      'start-call',
      START_INPUT,
    );
    const generateAssessment = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        type: 'exact_short_answer',
        acceptedAnswers: ['visible correct answer', privateCanary],
      }),
    );
    const verifyAssessment = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'accept',
        checks: {
          objectiveType: true,
          questionConsistent: true,
          answerConsistent: true,
          singleAnswerOrExactSet: true,
          middleSchoolScope: true,
        },
      }),
    );
    const attemptTool = toolFor(h, 2, 'visible correct answer', {
      generationCall: generateAssessment,
      transferVerificationCall: verifyAssessment,
    });
    const input = {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: 0,
    };
    const first = await execute(attemptTool, 'attempt-call-one', input);
    const replay = await execute(attemptTool, 'attempt-call-two', {
      ...input,
      expectedRevision: 999,
    });
    expect(first.output.state?.original.attemptCount).toBe(1);
    expect(replay.output).toMatchObject({
      ok: true,
      state: { original: { attemptCount: 1 } },
      facts: { replayed: true, eventAppended: false },
    });
    expect(generateAssessment).toHaveBeenCalledTimes(1);
    expect(verifyAssessment).toHaveBeenCalledTimes(1);

    for (const result of [first, replay]) {
      const envelope = result.raw as { content: unknown; details: unknown };
      expect(Check(ZHONGKAO_COACH_OUTPUT_SCHEMA, result.output)).toBe(true);
      expect(JSON.stringify(envelope.content)).not.toContain(privateCanary);
      expect(JSON.stringify(envelope.details)).not.toContain(privateCanary);
      expect(JSON.stringify(result.output.state)).not.toContain(privateCanary);
      expect(JSON.stringify(result.output)).not.toMatch(
        /assessmentPayload|assessmentEventId|evaluationEventId|gradingSpec|acceptedAnswers|candidateFingerprint|verificationRef/u,
      );
      expect(result.output.state?.original).not.toHaveProperty('outcome');
    }

    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((session) => session.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    expect(JSON.stringify(records)).toContain(privateCanary);
    expect(records.map((record) => (record.payload as CoachEvent).eventType)).toEqual([
      'coach_started',
      'student_attempt_submitted',
      'original_assessment_prepared',
      'original_attempt_evaluated',
      'original_resolved',
    ]);
  });

  it('replays one hint request across toolCallIds', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Question'), 'start', START_INPUT);
    const hintTool = toolFor(h, 2, 'One small hint.');
    const input = {
      action: 'request_hint',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: 0,
    };
    const first = await execute(hintTool, 'hint-one', input);
    const replay = await execute(hintTool, 'hint-two', { ...input, expectedRevision: 999 });
    expect(first.output.state?.original.hintsRequested).toBe(1);
    expect(first.output.presentation).toEqual({
      kind: 'hint',
      text: '先把题目中的已知条件和要解决的问题分别列出来。',
    });
    expect(replay.output.facts).toEqual({ replayed: true, eventAppended: false });
    expect(replay.output.presentation).toEqual(first.output.presentation);
  });

  it('persists a deterministic hint before presentation without calling a text generator', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Question'), 'start', START_INPUT);
    const badCall = vi.fn(async () => '{"schemaVersion":1,"hint":"","state":"forged"}');
    const issued = await execute(
      toolFor(h, 2, 'Hint please', { generationCall: badCall }),
      'hint-failed',
      {
        action: 'request_hint',
        profileId: 'student-alpha',
        coachSessionId: created.output.coachSessionId,
        expectedRevision: 0,
      },
    );
    expect(issued.output.presentation).toEqual({
      kind: 'hint',
      text: '先把题目中的已知条件和要解决的问题分别列出来。',
    });
    expect(badCall).not.toHaveBeenCalled();

    const retried = await execute(toolFor(h, 2, 'Hint please'), 'hint-retry', {
      action: 'request_hint',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: 999,
    });
    expect(retried.output.presentation).toEqual({
      kind: 'hint',
      text: '先把题目中的已知条件和要解决的问题分别列出来。',
    });
    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    expect(records.map((record) => (record.payload as { eventType: string }).eventType)).toEqual([
      'coach_started',
      'hint_requested',
      'hint_issued',
    ]);
    expect(records[2]?.payload).toMatchObject({
      hintText: '先把题目中的已知条件和要解决的问题分别列出来。',
    });
  });

  it('issues a deterministic transfer hint without reading the grading spec', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Question'), 'start', START_INPUT);
    const attempted = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: created.output.revision!,
      message: { seq: 2, text: 'A fictional incorrect attempt.' },
    });
    const attempt = attempted.snapshot.records.at(-1)!.payload as CoachEvent;
    const resolved = await recordOriginalResolved(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: attempted.snapshot.state.revision,
      attemptEventId: attempt.eventId,
      outcome: 'incorrect',
    });
    const resolution = resolved.snapshot.records.at(-1)!.payload as CoachEvent;
    const assigned = await assignVerifiedTransferQuestion(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: resolved.snapshot.state.revision,
      originalResolvedEventId: resolution.eventId,
      verifiedQuestion: verifiedTransferQuestion(
        created.output.coachSessionId!,
        resolution.eventId,
      ),
    });

    const issued = await execute(toolFor(h, 3, 'A transfer hint, please.'), 'transfer-hint', {
      action: 'request_hint',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: assigned.snapshot.state.revision,
    });

    expect(issued.output).toMatchObject({
      ok: true,
      facts: { replayed: false, eventAppended: true },
      state: { transfer: { hintsIssued: 1, keyHintUsed: false } },
      presentation: {
        kind: 'hint',
        text: '先把题目中的已知条件和要解决的问题分别列出来。',
      },
    });
    expect(JSON.stringify(issued.raw)).not.toContain('fictional transfer answer');
    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    expect(records.map((record) => (record.payload as CoachEvent).eventType)).toEqual([
      'coach_started',
      'student_attempt_submitted',
      'original_resolved',
      'transfer_question_assigned',
      'hint_requested',
      'hint_issued',
    ]);
    expect(issued.output.state?.transfer.hintsIssued).toBe(1);
  });

  it('generates, replays, and deterministically evaluates one trusted transfer answer', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Solve the fictional equation 2x = 8.'), 'start', {
      ...START_INPUT,
    });
    const attempted = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: created.output.revision!,
      message: { seq: 2, text: 'x = 5' },
    });
    const attempt = attempted.snapshot.records.at(-1)!.payload as CoachEvent;
    await recordOriginalResolved(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: attempted.snapshot.state.revision,
      attemptEventId: attempt.eventId,
      outcome: 'incorrect',
    });

    const generateCandidate = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        type: 'exact_short_answer',
        question: 'Write in English the number that makes 3x = 18.',
        expectedAnswer: { acceptedAnswers: ['six'] },
        knowledgePointIds: ['linear-equations'],
        difficulty: 'same',
        claims: [{ type: 'generic_knowledge_point' }],
      }),
    );
    const verifyCandidate = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'accept',
        checks: {
          sameKnowledgePoint: true,
          selfContained: true,
          answerConsistent: true,
          answerNotLeaked: true,
          singleAnswerOrExactSet: true,
          middleSchoolScope: true,
          meaningfullyDifferent: true,
        },
      }),
    );
    const stateTool = toolFor(h, 3, 'unused', {
      generationCall: generateCandidate,
      transferVerificationCall: verifyCandidate,
    });
    const question = await execute(stateTool, 'transfer-question', {
      action: 'get_state',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
    });
    expect(question.output).toMatchObject({
      ok: true,
      facts: { replayed: false, eventAppended: true },
      state: { status: 'transfer_pending', transfer: { assigned: true, attemptCount: 0 } },
      directive: 'WAIT_FOR_TRANSFER_ANSWER',
      presentation: {
        kind: 'transfer_question',
        type: 'exact_short_answer',
        question: 'Write in English the number that makes 3x = 18.',
        difficulty: 'same',
      },
    });

    const replay = await execute(stateTool, 'transfer-question-replay', {
      action: 'get_state',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
    });
    expect(replay.output).toMatchObject({
      ok: true,
      facts: { replayed: true, eventAppended: false },
    });
    expect(replay.output.presentation).toEqual(question.output.presentation);
    expect(generateCandidate).toHaveBeenCalledTimes(1);
    expect(verifyCandidate).toHaveBeenCalledTimes(1);

    const result = await execute(toolFor(h, 3, 'six'), 'transfer-answer', {
      action: 'submit_transfer_answer',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: question.output.revision,
    });
    expect(result.output).toMatchObject({
      ok: true,
      facts: { replayed: false, eventAppended: true },
      state: {
        status: 'finalizing',
        transfer: { assigned: true, attemptCount: 1, evaluated: true },
      },
      directive: 'PROJECT_STUDY_ATTEMPTS',
      presentation: {
        kind: 'transfer_result',
        outcome: 'correct',
        message: '这道迁移题答对了。',
      },
    });

    for (const raw of [question.raw, replay.raw, result.raw]) {
      expect(JSON.stringify(raw)).not.toMatch(
        /six|expectedAnswer|acceptedAnswers|gradingSpec|candidateFingerprint|verification|answerKey/iu,
      );
    }
    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    expect(records.map((record) => (record.payload as CoachEvent).eventType)).toEqual([
      'coach_started',
      'student_attempt_submitted',
      'original_resolved',
      'transfer_question_assigned',
      'transfer_answer_submitted',
      'transfer_answer_evaluated',
    ]);
    expect(sessions.map((session) => session.kind)).not.toContain('zhongkaoStudyAttempt');
  });

  it('reconciles a persisted transfer submission through get_state without reading the new turn', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Question'), 'start-pending-transfer', START_INPUT);
    const attempted = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: created.output.revision!,
      message: { seq: 2, text: 'A fictional incorrect attempt.' },
    });
    const attempt = attempted.snapshot.records.at(-1)!.payload as CoachEvent;
    const resolved = await recordOriginalResolved(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: attempted.snapshot.state.revision,
      attemptEventId: attempt.eventId,
      outcome: 'incorrect',
    });
    const resolution = resolved.snapshot.records.at(-1)!.payload as CoachEvent;
    const assigned = await assignVerifiedTransferQuestion(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: resolved.snapshot.state.revision,
      originalResolvedEventId: resolution.eventId,
      verifiedQuestion: verifiedTransferQuestion(
        created.output.coachSessionId!,
        resolution.eventId,
      ),
    });
    await submitCoachTransferAnswer(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: assigned.snapshot.state.revision,
      message: { seq: 3, text: 'fictional transfer answer' },
    });

    const reader = vi.fn(async () => ({ seq: 4, text: 'must not be read' }));
    const recovered = await execute(
      toolFor(h, 4, 'must not be read', { reader }),
      'recover-pending-transfer',
      {
        action: 'get_state',
        profileId: 'student-alpha',
        coachSessionId: created.output.coachSessionId,
      },
    );
    expect(reader).not.toHaveBeenCalled();
    expect(recovered.output).toMatchObject({
      ok: true,
      facts: { replayed: false, eventAppended: true },
      state: { status: 'finalizing', transfer: { attemptCount: 1, evaluated: true } },
      directive: 'PROJECT_STUDY_ATTEMPTS',
      presentation: {
        kind: 'transfer_result',
        outcome: 'correct',
        message: '这道迁移题答对了。',
      },
    });
    expect(JSON.stringify(recovered.raw)).not.toMatch(
      /fictional transfer answer|acceptedAnswers|gradingSpec|verification/iu,
    );

    const replayReader = vi.fn(async () => ({ seq: 5, text: 'must not be read either' }));
    const replayed = await execute(
      toolFor(h, 5, 'must not be read either', { reader: replayReader }),
      'replay-persisted-evaluation',
      {
        action: 'get_state',
        profileId: 'student-alpha',
        coachSessionId: created.output.coachSessionId,
      },
    );
    expect(replayReader).not.toHaveBeenCalled();
    expect(replayed.output).toMatchObject({
      ok: true,
      facts: { replayed: true, eventAppended: false },
      state: { status: 'finalizing', transfer: { attemptCount: 1, evaluated: true } },
      directive: 'PROJECT_STUDY_ATTEMPTS',
      presentation: recovered.output.presentation,
    });
  });

  it('uses the trusted latest CAS revision to clear the exact pending hint', async () => {
    const h = harness();
    await seedProfile(h);
    let injected = false;
    const racingStore = new Proxy(h.store, {
      get(target, property, receiver) {
        if (property === 'appendRecord') {
          return async (
            init: RuntimeRecordInit,
            options: Parameters<RuntimeStore['appendRecord']>[1],
          ) => {
            const event = init.payload as CoachEvent;
            if (!injected && event.eventType === 'hint_issued') {
              injected = true;
              const operationId = `coach-op:v2:${'d'.repeat(64)}`;
              const competing: CoachEvent = {
                schemaVersion: 1,
                eventId: deriveCoachEventId(operationId),
                coachSessionId: event.coachSessionId,
                profileId: event.profileId,
                eventType: 'student_attempt_submitted',
                createdAt: new Date(NOW + 90_000).toISOString(),
                agentSessionId: event.agentSessionId,
                sourceUserMessageSeq: 99,
                operationId,
                operationFingerprint: 'e'.repeat(64),
                phase: 'original',
                studentResponse: 'Concurrent fictional attempt.',
              };
              const appended = await target.appendRecord(
                {
                  id: competing.eventId,
                  sessionId: init.sessionId,
                  createdAt: competing.createdAt,
                  subAnchor: competing.eventId,
                  payload: competing,
                },
                { expectedLastSeq: options?.expectedLastSeq },
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
    }) as RuntimeStore;
    const created = await execute(
      toolFor(h, 1, 'Question', { runtimeStore: racingStore }),
      'start',
      START_INPUT,
    );
    const result = await execute(
      toolFor(h, 2, 'Hint please', { runtimeStore: racingStore }),
      'hint',
      {
        action: 'request_hint',
        profileId: 'student-alpha',
        coachSessionId: created.output.coachSessionId,
        expectedRevision: 0,
      },
    );
    expect(result.output).toMatchObject({
      ok: false,
      code: 'COACH_SESSION_CONFLICT',
      facts: { replayed: false, eventAppended: true },
      state: { original: { attemptCount: 1, hintsIssued: 0 } },
    });
    expect(result.output).not.toHaveProperty('presentation');
    expect(JSON.stringify(result.raw)).not.toContain(
      '先把题目中的已知条件和要解决的问题分别列出来。',
    );

    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    expect(records.map((record) => (record.payload as CoachEvent).eventType)).toEqual([
      'coach_started',
      'hint_requested',
      'student_attempt_submitted',
      'presentation_failed',
    ]);

    const next = await execute(toolFor(h, 3, 'Try the hint again.'), 'hint-retry', {
      action: 'request_hint',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: result.output.revision,
    });
    expect(next.output).toMatchObject({
      ok: true,
      presentation: {
        kind: 'hint',
        text: '先把题目中的已知条件和要解决的问题分别列出来。',
      },
    });
  });

  it('persists and replays one full solution only after an unlocked explicit request', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Solve 2x = 8.'), 'start', START_INPUT);
    const firstAttempt = await execute(toolFor(h, 2, 'x = 3'), 'attempt-1', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: 0,
    });
    const secondAttempt = await execute(toolFor(h, 3, 'x = 4'), 'attempt-2', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: firstAttempt.output.revision,
    });
    const solutionTool = toolFor(h, 4, 'Please show the full explanation.');
    const input = {
      action: 'request_full_solution',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: secondAttempt.output.revision,
    };
    const revealed = await execute(solutionTool, 'solution-1', input);
    const replay = await execute(solutionTool, 'solution-2', { ...input, expectedRevision: 999 });
    expect(revealed.output).toMatchObject({
      ok: true,
      state: { original: { viewedFullAnswer: true } },
      presentation: {
        kind: 'full_solution',
        explanation: 'Use inverse operations to isolate the unknown.',
        finalAnswer: 'x = 4',
      },
      directive: 'GENERATE_TRANSFER_QUESTION',
    });
    expect(replay.output.presentation).toEqual(revealed.output.presentation);
    expect(replay.output.facts).toEqual({ replayed: true, eventAppended: false });

    const transferCandidate = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        type: 'numeric',
        question: 'A number multiplied by 3 equals 15. What is the number?',
        expectedAnswer: { expectedNumericValue: 5 },
        knowledgePointIds: ['linear-equations'],
        difficulty: 'same',
        claims: [],
      }),
    );
    const transferVerifier = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'accept',
        checks: {
          sameKnowledgePoint: true,
          selfContained: true,
          answerConsistent: true,
          answerNotLeaked: true,
          singleAnswerOrExactSet: true,
          middleSchoolScope: true,
          meaningfullyDifferent: true,
        },
      }),
    );
    const state = await execute(
      toolFor(h, 5, 'State only', {
        generationCall: transferCandidate,
        transferVerificationCall: transferVerifier,
      }),
      'state',
      {
        action: 'get_state',
        profileId: 'student-alpha',
        coachSessionId: created.output.coachSessionId,
      },
    );
    expect(state.output).toMatchObject({
      ok: true,
      facts: { replayed: false, eventAppended: true },
      presentation: {
        kind: 'transfer_question',
        type: 'numeric',
        question: 'A number multiplied by 3 equals 15. What is the number?',
      },
    });
    expect(transferCandidate).toHaveBeenCalledTimes(1);
    expect(transferVerifier).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.raw)).not.toContain(
      'Use inverse operations to isolate the unknown.',
    );
  });

  it('repairs a reveal-only crash window through get_state before assigning transfer', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(
      toolFor(h, 1, 'Solve 2x = 8.'),
      'start-reveal-window',
      START_INPUT,
    );
    const first = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: created.output.revision!,
      message: { seq: 2, text: 'x = 3' },
    });
    const second = await submitCoachAttempt(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: first.snapshot.state.revision,
      message: { seq: 3, text: 'x = 5' },
    });
    const requested = await requestCoachFullSolution(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: second.snapshot.state.revision,
      message: { seq: 4, text: 'Show the full solution.' },
    });
    const request = requested.snapshot.records.at(-1)!.payload as CoachEvent;
    expect(request.eventType).toBe('full_solution_requested');
    const revealed = await recordFullSolutionRevealed(h.deps, {
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId!,
      expectedRevision: requested.snapshot.state.revision,
      requestEventId: request.eventId,
      explanation: 'A durable fictional explanation.',
      finalAnswer: 'x = 4',
    });
    expect(revealed.snapshot.state.original).toMatchObject({
      viewedFullAnswer: true,
      resolved: false,
    });

    const generateCandidate = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        type: 'numeric',
        question: 'A number multiplied by 3 equals 15. What is the number?',
        expectedAnswer: { expectedNumericValue: 5 },
        knowledgePointIds: ['linear-equations'],
        difficulty: 'same',
        claims: [],
      }),
    );
    const verifyCandidate = vi.fn<AICallFn>(async () =>
      JSON.stringify({
        schemaVersion: 1,
        verdict: 'accept',
        checks: {
          sameKnowledgePoint: true,
          selfContained: true,
          answerConsistent: true,
          answerNotLeaked: true,
          singleAnswerOrExactSet: true,
          middleSchoolScope: true,
          meaningfullyDifferent: true,
        },
      }),
    );
    const recovered = await execute(
      toolFor(h, 5, 'State only', {
        generationCall: generateCandidate,
        transferVerificationCall: verifyCandidate,
      }),
      'recover-reveal-window',
      {
        action: 'get_state',
        profileId: 'student-alpha',
        coachSessionId: created.output.coachSessionId,
      },
    );
    expect(recovered.output).toMatchObject({
      ok: true,
      state: { original: { viewedFullAnswer: true, resolved: true } },
      directive: 'WAIT_FOR_TRANSFER_ANSWER',
      presentation: { kind: 'transfer_question', type: 'numeric' },
    });
    const records = await h.store.listRecords(revealed.snapshot.session.id);
    expect(records.map((record) => (record.payload as CoachEvent).eventType).slice(-3)).toEqual([
      'full_solution_revealed',
      'original_resolved',
      'transfer_question_assigned',
    ]);
    expect(records.at(-2)?.payload).not.toHaveProperty('outcome');
  });

  it('binds full-solution generation to the execution signal and drops a late provider result', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Solve 2x = 8.'), 'start', START_INPUT);
    const firstAttempt = await execute(toolFor(h, 2, 'x = 3'), 'attempt-1', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: 0,
    });
    const secondAttempt = await execute(toolFor(h, 3, 'x = 4'), 'attempt-2', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: firstAttempt.output.revision,
    });

    let resolveProvider!: (value: string) => void;
    const providerResult = new Promise<string>((resolve) => {
      resolveProvider = resolve;
    });
    const generationCall = vi.fn<AICallFn>(async () => providerResult);
    const createGenerationCall = vi.fn((_signal?: AbortSignal): AICallFn => generationCall);
    const controller = new AbortController();
    const completion = execute(
      toolFor(h, 4, 'Please show the full explanation.', { createGenerationCall }),
      'solution-aborted',
      {
        action: 'request_full_solution',
        profileId: 'student-alpha',
        coachSessionId: created.output.coachSessionId,
        expectedRevision: secondAttempt.output.revision,
      },
      controller.signal,
    );
    await vi.waitFor(() => expect(generationCall).toHaveBeenCalledTimes(1));
    expect(createGenerationCall).toHaveBeenCalledWith(controller.signal);

    controller.abort(new Error('tool timeout'));
    resolveProvider(
      JSON.stringify({
        schemaVersion: 1,
        explanation: 'This late explanation must never be persisted.',
        finalAnswer: 'x = 4',
        claims: [],
      }),
    );
    const result = await completion;

    expect(result.output).toMatchObject({
      ok: false,
      code: 'COACH_RUNTIME_UNAVAILABLE',
      facts: { replayed: false, eventAppended: false },
    });
    expect(result.output).not.toHaveProperty('presentation');
    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    const eventTypes = records.map((record) => (record.payload as { eventType: string }).eventType);
    expect(eventTypes).not.toContain('full_solution_revealed');
    expect(eventTypes).not.toContain('presentation_failed');
    expect(JSON.stringify(records)).not.toContain('This late explanation must never be persisted.');
  });

  it('persists and replays a safe generation failure, then allows a new request', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Solve 2x = 8.'), 'start', START_INPUT);
    const firstAttempt = await execute(toolFor(h, 2, 'x = 3'), 'attempt-1', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: 0,
    });
    const secondAttempt = await execute(toolFor(h, 3, 'x = 4'), 'attempt-2', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: firstAttempt.output.revision,
    });
    const privateProviderError = 'private-provider-detail-must-not-persist';
    const generationCall = vi.fn<AICallFn>(async () =>
      Promise.reject(new Error(privateProviderError)),
    );
    const failedTool = toolFor(h, 4, 'Please show the full explanation.', { generationCall });
    const input = {
      action: 'request_full_solution',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: secondAttempt.output.revision,
    };

    const failed = await execute(failedTool, 'solution-failed', input);
    expect(failed.output).toMatchObject({
      ok: false,
      code: 'FULL_SOLUTION_GENERATION_FAILED',
      facts: { replayed: false, eventAppended: true },
    });
    expect(failed.output).not.toHaveProperty('presentation');

    const replay = await execute(failedTool, 'solution-failed-replay', {
      ...input,
      expectedRevision: 999,
    });
    expect(replay.output).toMatchObject({
      ok: false,
      code: 'FULL_SOLUTION_GENERATION_FAILED',
      facts: { replayed: true, eventAppended: false },
    });
    expect(generationCall).toHaveBeenCalledTimes(1);

    const retried = await execute(
      toolFor(h, 5, 'Please try the full explanation again.'),
      'solution-new-request',
      {
        ...input,
        expectedRevision: failed.output.revision,
      },
    );
    expect(retried.output).toMatchObject({
      ok: true,
      presentation: {
        kind: 'full_solution',
        explanation: 'Use inverse operations to isolate the unknown.',
      },
    });

    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    const failures = records
      .map((record) => record.payload as { eventType: string; failureCode?: string })
      .filter((event) => event.eventType === 'presentation_failed');
    expect(failures).toEqual([
      expect.objectContaining({ failureCode: 'FULL_SOLUTION_GENERATION_FAILED' }),
    ]);
    expect(JSON.stringify(records)).not.toContain(privateProviderError);
  });

  it('keeps facts false when the failure append response is lost and settles on replay', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Solve 2x = 8.'), 'start', START_INPUT);
    const firstAttempt = await execute(toolFor(h, 2, 'x = 3'), 'attempt-1', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: 0,
    });
    const secondAttempt = await execute(toolFor(h, 3, 'x = 4'), 'attempt-2', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: firstAttempt.output.revision,
    });
    const responseLossStore = new Proxy(h.store, {
      get(target, property, receiver) {
        if (property === 'appendRecord') {
          return async (
            init: RuntimeRecordInit,
            options: Parameters<RuntimeStore['appendRecord']>[1],
          ) => {
            const record = await target.appendRecord(init, options);
            if ((init.payload as { eventType?: string }).eventType === 'presentation_failed') {
              throw new Error('simulated response loss');
            }
            return record;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeStore;
    const generationCall = vi.fn<AICallFn>(async () =>
      Promise.reject(new Error('private provider failure')),
    );
    const input = {
      action: 'request_full_solution',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
      expectedRevision: secondAttempt.output.revision,
    };

    const uncertain = await execute(
      toolFor(h, 4, 'Please show the full explanation.', {
        generationCall,
        runtimeStore: responseLossStore,
      }),
      'solution-response-lost',
      input,
    );
    expect(uncertain.output).toMatchObject({
      ok: false,
      code: 'FULL_SOLUTION_GENERATION_FAILED',
      facts: { replayed: false, eventAppended: false },
    });

    const replay = await execute(
      toolFor(h, 4, 'Please show the full explanation.', { generationCall }),
      'solution-response-lost-replay',
      { ...input, expectedRevision: 999 },
    );
    expect(replay.output).toMatchObject({
      ok: false,
      code: 'FULL_SOLUTION_GENERATION_FAILED',
      facts: { replayed: true, eventAppended: false },
    });
    expect(generationCall).toHaveBeenCalledTimes(1);

    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    expect(
      records.filter(
        (record) => (record.payload as { eventType: string }).eventType === 'presentation_failed',
      ),
    ).toHaveLength(1);
  });

  it('verifies material source through the server adapter and never accepts page input', async () => {
    const h = harness();
    await seedProfile(h);
    const materialSource: ZhongkaoMaterialSourceAdapter = {
      resolve: vi.fn(async () => ({
        materialId: 'mat_alpha',
        displayName: '虚构数学材料',
        source: { type: 'uploaded_material' as const, sourceId: 'mat_alpha' },
        verifier: ((candidate) =>
          candidate.type === 'uploaded_material' &&
          candidate.sourceId === 'mat_alpha') satisfies CurriculumSourceVerifier,
      })),
    };
    const started = await execute(
      toolFor(h, 1, 'Typed trusted question remains authoritative.', { materialSource }),
      'material-start',
      {
        ...START_INPUT,
        questionSourceType: 'material',
        materialId: 'mat_alpha',
      },
    );
    expect(started.output.ok).toBe(true);
    expect(materialSource.resolve).toHaveBeenCalledWith('mat_alpha');
    expect(
      Check(ZHONGKAO_COACH_ACTION_SCHEMA, {
        ...START_INPUT,
        questionSourceType: 'material',
        materialId: 'mat_alpha',
        sourcePage: 9,
      }),
    ).toBe(false);
  });

  it('fails a material start closed without creating a Coach event', async () => {
    const h = harness();
    await seedProfile(h);
    const failed = await execute(
      toolFor(h, 1, 'Question', {
        materialSource: {
          resolve: vi.fn(async () =>
            Promise.reject(new CoachError('MATERIAL_SOURCE_NOT_VERIFIED')),
          ),
        },
      }),
      'material-failed',
      {
        ...START_INPUT,
        questionSourceType: 'material',
        materialId: 'mat_foreign',
      },
    );
    expect(failed.output).toMatchObject({ ok: false, code: 'MATERIAL_SOURCE_NOT_VERIFIED' });
    expect(failed.output).not.toHaveProperty('presentation');
  });

  it('does not persist a failure code from the wrong presentation family', async () => {
    const h = harness();
    await seedProfile(h);
    const verifiedMaterial = {
      materialId: 'mat_alpha',
      displayName: '虚构数学材料',
      source: { type: 'uploaded_material' as const, sourceId: 'mat_alpha' },
      verifier: ((candidate) =>
        candidate.type === 'uploaded_material' &&
        candidate.sourceId === 'mat_alpha') satisfies CurriculumSourceVerifier,
    };
    const materialSource: ZhongkaoMaterialSourceAdapter = {
      resolve: vi
        .fn<ZhongkaoMaterialSourceAdapter['resolve']>()
        .mockResolvedValueOnce(verifiedMaterial)
        .mockRejectedValueOnce(new CoachError('HINT_CONTENT_INVALID')),
    };
    const started = await execute(
      toolFor(h, 1, 'Solve 2x = 8.', { materialSource }),
      'material-start-for-mismatch',
      {
        ...START_INPUT,
        questionSourceType: 'material',
        materialId: 'mat_alpha',
      },
    );
    const firstAttempt = await execute(toolFor(h, 2, 'x = 3'), 'material-attempt-1', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: started.output.coachSessionId,
      expectedRevision: started.output.revision,
    });
    const secondAttempt = await execute(toolFor(h, 3, 'x = 4'), 'material-attempt-2', {
      action: 'submit_attempt',
      profileId: 'student-alpha',
      coachSessionId: started.output.coachSessionId,
      expectedRevision: firstAttempt.output.revision,
    });
    const failed = await execute(
      toolFor(h, 4, 'Please show the full explanation.', { materialSource }),
      'material-solution-mismatched-failure',
      {
        action: 'request_full_solution',
        profileId: 'student-alpha',
        coachSessionId: started.output.coachSessionId,
        expectedRevision: secondAttempt.output.revision,
      },
    );

    expect(failed.output).toMatchObject({
      ok: false,
      code: 'HINT_CONTENT_INVALID',
      facts: { replayed: false, eventAppended: false },
    });
    const sessions = await h.store.listSessions(
      'zhongkao-profile:student-alpha',
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
    );
    const coach = sessions.find((candidate) => candidate.kind === 'zhongkaoCoachEvent')!;
    const records = await h.store.listRecords(coach.id);
    expect(
      records.filter(
        (record) => (record.payload as { eventType: string }).eventType === 'presentation_failed',
      ),
    ).toHaveLength(0);
  });

  it('does not reread material content when issuing a deterministic hint', async () => {
    const h = harness();
    await seedProfile(h);
    const resolve = vi
      .fn<ZhongkaoMaterialSourceAdapter['resolve']>()
      .mockResolvedValueOnce({
        materialId: 'mat_alpha',
        displayName: 'Fictional material',
        source: { type: 'uploaded_material', sourceId: 'mat_alpha' },
        verifier: (candidate) =>
          candidate.type === 'uploaded_material' && candidate.sourceId === 'mat_alpha',
      })
      .mockResolvedValueOnce({
        materialId: 'mat_beta',
        displayName: 'Different fictional material',
        source: { type: 'uploaded_material', sourceId: 'mat_beta' },
        verifier: (candidate) =>
          candidate.type === 'uploaded_material' && candidate.sourceId === 'mat_beta',
      });
    const materialSource = { resolve };
    const started = await execute(
      toolFor(h, 1, 'Typed question.', { materialSource }),
      'material-start',
      {
        ...START_INPUT,
        questionSourceType: 'material',
        materialId: 'mat_alpha',
      },
    );
    const hint = await execute(toolFor(h, 2, 'Hint please.', { materialSource }), 'hint', {
      action: 'request_hint',
      profileId: 'student-alpha',
      coachSessionId: started.output.coachSessionId,
      expectedRevision: started.output.revision,
    });
    expect(hint.output.presentation).toEqual({
      kind: 'hint',
      text: '先把题目中的已知条件和要解决的问题分别列出来。',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('does not call the bound reader for get_state', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(toolFor(h, 1, 'Question'), 'start', START_INPUT);
    const reader = vi.fn(async () => ({ seq: 2, text: 'unused' }));
    const stateTool = toolFor(h, 2, 'unused', { reader });
    const { output } = await execute(stateTool, 'get-state', {
      action: 'get_state',
      profileId: 'student-alpha',
      coachSessionId: created.output.coachSessionId,
    });
    expect(output.ok).toBe(true);
    expect(reader).not.toHaveBeenCalled();
  });

  it('uses one validated DTO for details and serialized content', async () => {
    const h = harness();
    await seedProfile(h);
    const { output, raw } = await execute(
      toolFor(h, 1, 'Sensitive fictional student question.'),
      'start',
      START_INPUT,
    );
    expect(Check(ZHONGKAO_COACH_OUTPUT_SCHEMA, output)).toBe(true);
    const result = raw as { content: Array<{ text: string }>; details: ZhongkaoCoachToolOutput };
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details);
  });

  it('does not expose identity, messages, causal refs, answers, or internal state', async () => {
    const h = harness();
    await seedProfile(h);
    const { raw } = await execute(
      toolFor(h, 1, 'Sensitive fictional student question.'),
      'start',
      START_INPUT,
    );
    const serialized = JSON.stringify(raw);
    for (const forbidden of [
      'Sensitive fictional student question.',
      h.deps.ownerId,
      resolveZhongkaoLearnerKeyFromOwnerId(h.deps.ownerId),
      h.deps.agentSessionId,
      'sourceUserMessageSeq',
      'userMessageSeq',
      'eventId',
      'operationId',
      'operationFingerprint',
      'requestEventId',
      'sourceAgentSessionIds',
      'questionMessageRef',
      'studentResponse',
      'answerKey',
      'rubric',
      'expectedAnswer',
      'answerUnlocked',
      'isIndependent',
      'mastered',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('keeps internal actions out of the browser barrel while the runner uses frozen gating', () => {
    const runner = readFileSync('lib/server/agent-runtime/runner.ts', 'utf8');
    const barrel = readFileSync('lib/zhongkao/index.ts', 'utf8');
    expect(runner).toContain("meta.skillId !== 'zhongkao-coach'");
    expect(runner).toContain('createZhongkaoCoachActionTool');
    expect(barrel).not.toContain('coach-service');
    expect(barrel).not.toContain('recordHintIssued');
  });
});
