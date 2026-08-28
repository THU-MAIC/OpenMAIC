import { readFileSync } from 'node:fs';

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { BrowserRuntimeStore, type RuntimeStore } from '@openmaic/storage';
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
import type { CoachServiceDeps } from '@/lib/server/zhongkao/coach-service';
import { resolveZhongkaoLearnerKeyFromOwnerId } from '@/lib/server/zhongkao/learner-identity';
import { createInitialStudentProfile } from '@/lib/zhongkao/profile';
import { saveStudentProfile } from '@/lib/zhongkao/runtime';

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
  } = {},
): AgentTool<never, never> {
  return createZhongkaoCoachActionTool({
    trustedTurn:
      options.turn ??
      ({
        ownerId: h.deps.ownerId,
        agentSessionId: h.deps.agentSessionId,
        userMessageSeq: seq,
      } satisfies TrustedAgentTurn),
    runtimeStore: h.store,
    readTrustedUserMessage: options.reader ?? (async () => ({ seq, text })),
    now: h.now,
  });
}

async function execute(
  tool: AgentTool<never, never>,
  toolCallId: string,
  params: Record<string, unknown>,
): Promise<{ output: ZhongkaoCoachToolOutput; raw: unknown }> {
  const raw = await (
    tool.execute as (
      id: string,
      value: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<unknown>
  )(toolCallId, params, undefined);
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
    'createdAt',
    'answerUnlocked',
    'viewedFullAnswer',
    'isIndependent',
    'mastered',
    'verifiedSource',
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

  it('replays one submit across different toolCallIds and keeps the phase count at one', async () => {
    const h = harness();
    await seedProfile(h);
    const created = await execute(
      toolFor(h, 1, 'Solve trusted fictional 2x = 8.'),
      'start-call',
      START_INPUT,
    );
    const attemptTool = toolFor(h, 2, 'x equals 4');
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
    expect(replay.output.facts).toEqual({ replayed: true, eventAppended: false });
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

  it('keeps the tool absent from the runner and browser barrel', () => {
    const runner = readFileSync('lib/server/agent-runtime/runner.ts', 'utf8');
    const barrel = readFileSync('lib/zhongkao/index.ts', 'utf8');
    expect(runner).not.toContain('zhongkao_coach_action');
    expect(runner).not.toContain('createZhongkaoCoachActionTool');
    expect(barrel).not.toContain('coach-service');
    expect(barrel).not.toContain('recordHintIssued');
  });
});
