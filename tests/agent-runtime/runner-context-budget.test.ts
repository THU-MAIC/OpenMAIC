/**
 * Runner-level pins for conversation compaction and the context budget check.
 *
 * Drives the real `runSession` loop through a fake agent that behaves like pi
 * at the context boundary: before its model call it runs the `transformContext`
 * hook the runner registered, and a hook that throws ends the run with pi's
 * error assistant frame. The entry tree is a real in-memory pi Session, so the
 * durable CompactionEntry and the next run's recovered history are observable.
 */
import type {
  AgentEvent,
  AgentMessage,
  SessionTreeEntry,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ClaimedAgentSession } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  courseToolDeps: [] as Array<{ getActiveSkill?: () => { id: string } | null }>,
}));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomUUID: mocks.randomUUID };
});
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));
vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: vi.fn(async () => []) };
});
vi.mock('@/lib/server/agent-runtime/material-resolver', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/material-resolver')>();
  return { ...actual, listSessionScopeMaterials: vi.fn(async () => []) };
});
vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return { ...actual, AgentSessionEntryStorage: { open: mocks.openEntryStorage } };
});
vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: mocks.resolveAgentDriverModel,
}));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));
vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.buildAgent }));
// Pass-through that records the runner's active-skill accessor.
vi.mock('@/lib/server/agent-runtime/course-tools', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/course-tools')>();
  return {
    ...actual,
    buildDslCourseToolset: (deps: Parameters<typeof actual.buildDslCourseToolset>[0]) => {
      mocks.courseToolDeps.push(deps as (typeof mocks.courseToolDeps)[number]);
      return actual.buildDslCourseToolset(deps);
    },
  };
});
vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return { ...actual, listSkills: vi.fn(async () => []), findSkill: vi.fn(async () => null) };
});
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

import { runSession } from '@/lib/server/agent-runtime/runner';
import { listSkills, type LoadedSkill } from '@/lib/server/agent-runtime/skills';

const SESSION_ID = 'session-ctx';
const WORKER_ID = `runner-t:${process.pid}`;
const CONTEXT_WINDOW = 128_000;
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type BuildAgentOptions = {
  history?: AgentMessage[];
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
};

function assistant(text: string, timestamp: number, extra: Partial<AssistantMessage> = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'driver-model',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp,
    ...extra,
  } as AssistantMessage as AgentMessage;
}

/** A completed conversation of `turns` user/assistant pairs, ~`tokens` each. */
function conversation(turns: number, tokens: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, index) => [
    {
      role: 'user',
      content: `question ${index}: ${'x'.repeat(tokens * 4)}`,
      timestamp: index * 2 + 1,
    } as AgentMessage,
    assistant(`answer ${index}: ${'y'.repeat(tokens * 4)}`, index * 2 + 2),
  ]).flat();
}

function summaryStream(summary: string, onCall: () => void): StreamFn {
  return (() => {
    onCall();
    const stream = createAssistantMessageEventStream();
    const message = assistant(summary, Date.now()) as AssistantMessage;
    queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message }));
    return stream;
  }) as StreamFn;
}

function makeMeta(overrides: Partial<ClaimedAgentSession> = {}): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'owner-1',
    prompt: 'Build a lesson',
    stageId: 'stage-1',
    existingCourse: false,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    claimReason: 'queued',
    claimSeq: 1,
    deliveredUserMessageSeq: 0,
    ...overrides,
  };
}

/** One durable follow-up (seq 1) that existed when the session was claimed. */
function makeStore(meta: ClaimedAgentSession, text = 'Continue the lesson') {
  let seq = 10;
  const pending = [{ seq: 1, ts: 1, text, delivery: 'queued', materials: [] }];
  return {
    appendRunEvent: vi.fn(
      async (
        _id: string,
        _workerId: string,
        _event: { type: string; data?: Record<string, unknown> },
      ) => ++seq,
    ),
    pruneMessageUpdates: vi.fn(async () => 0),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async (..._args: unknown[]) => true),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => pending),
    markUserMessageDelivered: vi.fn(async () => true),
    releaseLease: vi.fn(async (): Promise<void> => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
}
type FakeStore = ReturnType<typeof makeStore>;

const sessionEnd = (store: FakeStore) =>
  store.appendRunEvent.mock.calls.map((call) => call[2]).find((e) => e.type === 'session_end');

/**
 * A pi-shaped agent: prompt() records the user frames, runs the registered
 * context transform, then answers — or, when the transform throws, ends the
 * run with pi's error frame (agent.handleRunFailure) without a model call.
 */
function makePiLikeAgent(options: BuildAgentOptions, seen: { views: AgentMessage[][] }) {
  const messages = [...(options.history ?? [])];
  const listeners = new Set<(event: AgentEvent) => void>();
  let errorMessage: string | undefined;
  const emit = (event: AgentEvent) => {
    if (event.type === 'message_end') messages.push(event.message);
    for (const listener of [...listeners]) listener(event);
  };
  const finish = (message: AgentMessage) => {
    emit({ type: 'message_start', message });
    emit({ type: 'message_end', message });
    emit({ type: 'agent_end', messages: [message] });
  };
  return {
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (input: string | AgentMessage[]) => {
      const frames =
        typeof input === 'string'
          ? [{ role: 'user', content: input, timestamp: Date.now() } as AgentMessage]
          : input;
      emit({ type: 'agent_start' });
      for (const frame of frames) {
        emit({ type: 'message_start', message: frame });
        emit({ type: 'message_end', message: frame });
      }
      try {
        const view = options.transformContext
          ? await options.transformContext([...messages])
          : [...messages];
        seen.views.push(view);
        finish(assistant('Here is the next step.', Date.now()));
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        finish(assistant('', Date.now(), { stopReason: 'error', errorMessage }));
      }
    },
    continue: async () => {},
    waitForIdle: async () => {},
    steer: () => {},
    abort: () => {},
    state: {
      get messages() {
        return messages;
      },
      get errorMessage() {
        return errorMessage;
      },
    },
  };
}

async function seedTree(messages: AgentMessage[]): Promise<Session> {
  const session = await new InMemorySessionRepo().create({ id: SESSION_ID });
  for (const message of messages) await session.appendMessage(message);
  return session;
}

/** Run one claim against `tree`; returns what the fake agent saw. */
async function runOnce(tree: Session, store: FakeStore, meta: ClaimedAgentSession) {
  const seen = { views: [] as AgentMessage[][], options: [] as BuildAgentOptions[] };
  mocks.getAgentSessionStore.mockResolvedValue(store);
  mocks.openEntryStorage.mockResolvedValue(tree.getStorage());
  mocks.buildAgent.mockImplementation((options: BuildAgentOptions) => {
    seen.options.push(options);
    return makePiLikeAgent(options, seen);
  });
  await runSession({ running: new Map(), shuttingDown: false }, meta);
  return seen;
}

const entriesOf = async (tree: Session, type: SessionTreeEntry['type']) =>
  (await tree.getEntries()).filter((entry) => entry.type === type);

let summaryCalls = 0;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.courseToolDeps.length = 0;
  summaryCalls = 0;
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined, modelString: 'test:driver-model' },
    piModel: {
      api: 'openai-completions',
      provider: 'test',
      id: 'driver-model',
      contextWindow: CONTEXT_WINDOW,
      maxTokens: 8192,
    },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue(
    summaryStream('Summary: the learner is building a lesson.', () => (summaryCalls += 1)),
  );
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

describe('runner conversation compaction', () => {
  it('leaves an under-budget session untouched', async () => {
    const history = conversation(2, 50);
    const tree = await seedTree(history);
    const meta = makeMeta();
    const store = makeStore(meta);

    const seen = await runOnce(tree, store, meta);

    expect(summaryCalls).toBe(0);
    expect(await entriesOf(tree, 'compaction')).toHaveLength(0);
    expect(seen.views).toHaveLength(1);
    expect(seen.views[0]!.slice(0, history.length)).toEqual(history);
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('appends a CompactionEntry and the next run resumes from summary + kept suffix', async () => {
    // ~160K tokens of history against a 128K window.
    const history = conversation(20, 4_000);
    const tree = await seedTree(history);
    const meta = makeMeta();
    const store = makeStore(meta);

    const first = await runOnce(tree, store, meta);

    // pi may summarize a split turn's prefix in a second call.
    expect(summaryCalls).toBeGreaterThan(0);
    const summaryCallsAfterCompaction = summaryCalls;
    const compactions = await entriesOf(tree, 'compaction');
    expect(compactions).toHaveLength(1);
    const view = first.views[0]!;
    expect(view[0]?.role).toBe('compactionSummary');
    expect(view.length).toBeLessThan(history.length);
    // Raw entries are never deleted: every original message is still in the tree.
    const rawEntries = await entriesOf(tree, 'message');
    expect(rawEntries.length).toBeGreaterThan(history.length);
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'succeeded' }),
    );
    expect(
      store.appendRunEvent.mock.calls.some(
        (call) =>
          call[2].type === 'trace' && String(call[2].data?.message).includes('context compacted'),
      ),
    ).toBe(true);

    // The next claim recovers the compacted view from the durable tree.
    const nextMeta = makeMeta({ claimSeq: 2, deliveredUserMessageSeq: 1 });
    const nextStore = makeStore(nextMeta, 'And the next part');
    nextStore.listUserMessages.mockResolvedValue([
      { seq: 1, ts: 1, text: 'Continue the lesson', delivery: 'queued', materials: [] },
      { seq: 2, ts: 2, text: 'And the next part', delivery: 'queued', materials: [] },
    ]);
    const second = await runOnce(tree, nextStore, nextMeta);

    const resumedHistory = second.options[0]!.history!;
    expect(resumedHistory[0]?.role).toBe('compactionSummary');
    expect(JSON.stringify(resumedHistory[0])).toContain('the learner is building a lesson');
    // The kept suffix is the raw tail of the first run, ending with its answer.
    expect(resumedHistory.slice(1)).toEqual(view.slice(1).concat(resumedHistory.slice(-1)));
    expect(summaryCalls).toBe(summaryCallsAfterCompaction);
    expect(await entriesOf(tree, 'compaction')).toHaveLength(1);
    expect(nextStore.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({ status: 'succeeded' }),
    );
  });
});

describe('runner summary stream for an unknown-output model', () => {
  it('caps summary requests while conversation replies stay uncapped', async () => {
    // The driver mock has no catalog output window (wireMaxOutputTokens undefined).
    const created: Array<{ omitMaxOutputTokens?: boolean; maxOutputTokens?: number }> = [];
    const summaryRequests: Array<{ omit?: boolean; maxTokens?: number }> = [];
    mocks.createCallLlmStreamFn.mockImplementation(
      (opts: { omitMaxOutputTokens?: boolean; maxOutputTokens?: number }) => {
        created.push(opts);
        const fn = summaryStream('Summary.', () => {});
        return ((model, context, options) => {
          summaryRequests.push({ omit: opts.omitMaxOutputTokens, maxTokens: options?.maxTokens });
          return fn(model, context, options);
        }) as StreamFn;
      },
    );
    const tree = await seedTree(conversation(20, 4_000));
    const meta = makeMeta();
    await runOnce(tree, makeStore(meta), meta);

    expect(await entriesOf(tree, 'compaction')).toHaveLength(1);
    // The conversation stream omits any wire cap for the unknown model...
    expect(created[0]).toMatchObject({ omitMaxOutputTokens: true });
    // ...but every summary request goes through a stream that keeps pi's cap.
    expect(summaryRequests.length).toBeGreaterThan(0);
    for (const request of summaryRequests) {
      expect(request.omit).not.toBe(true);
      expect(request.maxTokens).toBeGreaterThan(0);
    }
  });
});

describe('runner context budget block', () => {
  const expectBlockedOnce = (store: FakeStore, reason: string) => {
    expect(store.finishSession).toHaveBeenCalledOnce();
    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.objectContaining({
        status: 'failed',
        error: `CONTEXT_BUDGET_EXCEEDED:${reason}`,
        resetAttempt: true,
      }),
    );
    expect(sessionEnd(store)?.data).toMatchObject({
      status: 'failed',
      errorCode: 'CONTEXT_BUDGET_EXCEEDED',
    });
    // The undelivered claim-time message is not retried unattended.
    expect(store.requeueForRetry).not.toHaveBeenCalled();
    expect(store.requeueSession).not.toHaveBeenCalled();
  };

  it('blocks an over-budget prompt when the summary fails, without sending or writing a boundary', async () => {
    mocks.createCallLlmStreamFn.mockReturnValue((() => {
      summaryCalls += 1;
      throw new Error('summary provider unavailable');
    }) as StreamFn);
    const history = conversation(20, 4_000);
    const tree = await seedTree(history);
    const meta = makeMeta();
    const store = makeStore(meta);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const seen = await runOnce(tree, store, meta);

      expect(summaryCalls).toBeGreaterThan(0);
      expect(seen.views).toHaveLength(0);
      expect(await entriesOf(tree, 'compaction')).toHaveLength(0);
      expectBlockedOnce(store, 'summary_failed');
      // One line explains the block, with the cause as metadata only.
      const blockedLine = String(
        warn.mock.calls.find(([line]) => String(line).includes('context admission blocked'))?.[0],
      );
      const blocked = JSON.parse(blockedLine.slice(blockedLine.indexOf('{')));
      expect(blocked).toMatchObject({
        reason: 'summary_failed',
        summaryFailure: {
          errorName: 'Error',
          timeoutOrAbort: false,
          modelRoute: 'agent slot model test:driver-model',
        },
      });
      expect(blocked.summaryFailure).not.toHaveProperty('message');
      expect(blockedLine).not.toContain('summary provider unavailable');
      expect(blockedLine).not.toContain('question 0');
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('blocks when the context is still over budget after compaction, with a non-retryable settle', async () => {
    const tree = await seedTree(conversation(2, 50));
    const meta = makeMeta();
    // One message larger than the whole window: no cut can make it fit.
    const store = makeStore(meta, `huge: ${'z'.repeat(CONTEXT_WINDOW * 4)}`);
    // Stranded: the message is still undelivered when the run settles.
    store.markUserMessageDelivered.mockResolvedValue(true);
    store.getSession.mockResolvedValue({
      ...meta,
      deliveredUserMessageSeq: 0,
      lease: { workerId: WORKER_ID },
    });

    const seen = await runOnce(tree, store, meta);

    expect(seen.views).toHaveLength(0);
    // Decided before any summary is paid for.
    expect(summaryCalls).toBe(0);
    expect(await entriesOf(tree, 'compaction')).toHaveLength(0);
    expect(store.finishSession.mock.calls[0]![2]).toMatchObject({
      error: expect.stringMatching(
        /^CONTEXT_BUDGET_EXCEEDED:(still_oversized|no_compaction_boundary)$/,
      ),
    });
    const reason = String((store.finishSession.mock.calls[0]![2] as { error: string }).error).split(
      ':',
    )[1]!;
    expectBlockedOnce(store, reason);
  });

  it('keeps unattended retry for an ordinary model failure (contrast)', async () => {
    const tree = await seedTree(conversation(2, 50));
    const meta = makeMeta();
    const store = makeStore(meta);
    mocks.buildAgent.mockImplementation(() => ({
      ...makePiLikeAgent({}, { views: [] }),
      prompt: async () => {
        throw new Error('unused');
      },
    }));
    store.getSession.mockResolvedValue({
      ...meta,
      deliveredUserMessageSeq: 0,
      lease: { workerId: WORKER_ID },
    });
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockResolvedValue(tree.getStorage());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runSession({ running: new Map(), shuttingDown: false }, meta);
    } finally {
      error.mockRestore();
    }

    expect(store.finishSession).toHaveBeenCalledWith(
      SESSION_ID,
      WORKER_ID,
      expect.not.objectContaining({ resetAttempt: true }),
    );
    expect(store.requeueForRetry).toHaveBeenCalledOnce();
  });
});

describe('runner skill activation across compaction', () => {
  it('keeps the active skill when its read was summarized away', async () => {
    const skill: LoadedSkill = {
      id: 'usk_lesson_style',
      name: 'lesson-style',
      description: 'A personal lesson style',
      content: 'Write short slides.',
      filePath: 'user-skills/usk_lesson_style/SKILL.md',
      constraints: null,
      source: 'user',
    };
    vi.mocked(listSkills).mockResolvedValue([skill]);
    const read: AgentMessage[] = [
      { role: 'user', content: 'use my lesson style', timestamp: 1 } as AgentMessage,
      {
        ...assistant('', 2),
        content: [
          { type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: skill.filePath } },
        ],
        stopReason: 'toolUse',
      } as AgentMessage,
      {
        role: 'toolResult',
        toolCallId: 'call-read',
        toolName: 'read',
        content: [{ type: 'text', text: skill.content }],
        isError: false,
        timestamp: 3,
      } as AgentMessage,
      assistant('Loaded.', 4),
    ];
    // The skill read is the oldest turn; ~160K tokens follow it.
    const tree = await seedTree([...read, ...conversation(20, 4_000)]);
    const meta = makeMeta();
    await runOnce(tree, makeStore(meta), meta);
    expect(await entriesOf(tree, 'compaction')).toHaveLength(1);

    const nextMeta = makeMeta({ claimSeq: 2, deliveredUserMessageSeq: 1 });
    const nextStore = makeStore(nextMeta, 'continue');
    nextStore.listUserMessages.mockResolvedValue([
      { seq: 1, ts: 1, text: 'Continue the lesson', delivery: 'queued', materials: [] },
      { seq: 2, ts: 2, text: 'continue', delivery: 'queued', materials: [] },
    ]);
    mocks.courseToolDeps.length = 0;
    const second = await runOnce(tree, nextStore, nextMeta);

    // The model view no longer holds the read...
    const history = second.options[0]!.history!;
    expect(history[0]?.role).toBe('compactionSummary');
    expect(JSON.stringify(history)).not.toContain('call-read');
    // ...but the session is still planned under the skill.
    expect(mocks.courseToolDeps.at(-1)?.getActiveSkill?.()?.id).toBe(skill.id);
  });
});
