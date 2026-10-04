/**
 * A run that fails while starting (before it completes any message) writes
 * nothing to the entry tree. The session must stay usable: the next run starts
 * the conversation over on the empty tree, and only a tree that lost messages
 * the event log shows were completed is refused.
 *
 * The store here keeps a real event log (sequence numbers shared by run
 * events and user messages), so the runner reads its prior runs the way it
 * does against Postgres.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, type Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession, PersistedAgentSessionEvent } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentSessionStore: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
}));

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
vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return { ...actual, AgentSessionEntryStorage: { open: mocks.openEntryStorage } };
});
// A named classroom is looked up in the owner's library; none exists here.
vi.mock('@/lib/server/agent-runtime/curriculum-tools', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/curriculum-tools')>();
  return { ...actual, probeStageAccess: vi.fn(async () => ({ kind: 'missing' })) };
});
// ...and no generation run is producing it.
vi.mock('@/lib/server/agent-runtime/course-generation', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/course-generation')>();
  return { ...actual, listCourseGenerations: vi.fn(async () => new Map()) };
});
vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: mocks.resolveAgentDriverModel,
}));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));
vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.buildAgent }));
vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return { ...actual, listSkills: vi.fn(async () => []), findSkill: vi.fn(async () => null) };
});
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

import { readPriorRunRecord } from '@/lib/server/agent-runtime/entry-tree-storage';
import { runSession } from '@/lib/server/agent-runtime/runner';

const SESSION_ID = 'session-1';

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
    claimSeq: 0,
    deliveredUserMessageSeq: 0,
    ...overrides,
  };
}

/** A store whose event log is shared by run events and user messages, as in Postgres. */
function makeStore() {
  const events: PersistedAgentSessionEvent[] = [];
  let delivered = 0;
  let workerId: string | undefined;
  let attempt = 1;
  const push = (type: string, data: unknown, attempt = 1): number => {
    const id = events.length + 1;
    events.push({ id, ts: id, attempt, type, data });
    return id;
  };
  const store = {
    events,
    postUserMessage: (text: string, extra: Record<string, unknown> = {}) =>
      push('user_message', { text, delivery: 'queued', materials: [], ...extra }),
    delivered: () => delivered,
    appendRunEvent: vi.fn(
      async (
        _id: string,
        worker: string,
        event: { type: string; data?: unknown; attempt: number },
      ) => {
        workerId = worker;
        attempt = event.attempt;
        return push(event.type, event.data, event.attempt);
      },
    ),
    pruneMessageUpdates: vi.fn(async () => 0),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(
      async (_id: string, _worker: string, _patch: Record<string, unknown>) => true,
    ),
    getSession: vi.fn(async () => ({
      ...makeMeta({ attempt }),
      deliveredUserMessageSeq: delivered,
      lease: { workerId },
    })),
    readEventsAfter: vi.fn(async (_id: string, after: number, limit = 500) =>
      events.filter((event) => event.id > after).slice(0, limit),
    ),
    markUserMessageDelivered: vi.fn(async (_id, _worker, _attempt, seq: number) => {
      delivered = Math.max(delivered, seq);
      return true;
    }),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
  return store;
}

type FakeStore = ReturnType<typeof makeStore>;

const textOf = (message: AgentMessage): string => {
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content);
};

/** An agent that answers every user message it is given with one assistant message. */
function makeAgent(received: string[]) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const messages: AgentMessage[] = [];
  const emit = (event: AgentEvent) => {
    if (event.type === 'message_end') messages.push(event.message);
    for (const listener of [...listeners]) listener(event);
  };
  const answer = (user: AgentMessage) => {
    received.push(textOf(user));
    emit({ type: 'message_start', message: user });
    emit({ type: 'message_end', message: user });
    const reply = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'stop',
      timestamp: Date.now(),
    } as unknown as AgentMessage;
    emit({ type: 'message_start', message: reply });
    emit({ type: 'message_end', message: reply });
  };
  return {
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async (input: unknown) => {
      const first = Array.isArray(input) ? input[0] : input;
      answer(
        typeof first === 'string'
          ? ({ role: 'user', content: first, timestamp: Date.now() } as unknown as AgentMessage)
          : (first as AgentMessage),
      );
    },
    continue: async () => {},
    waitForIdle: async () => {},
    steer: (message: AgentMessage) => answer(message),
    abort: () => {},
    clearAllQueues: () => {},
    state: {
      get messages() {
        return messages;
      },
      errorMessage: undefined,
    },
  };
}

const DRIVER = {
  connection: { model: undefined, thinkingConfig: undefined },
  piModel: { api: 'openai-completions', provider: 'openai', id: 'driver-model' },
  wireMaxOutputTokens: undefined,
  reservedOutputTokens: 8192,
};

async function emptyTree(): Promise<Session> {
  return new InMemorySessionRepo().create({ id: SESSION_ID });
}

const runTypes = (store: FakeStore, fromSeq: number) =>
  store.events.filter((event) => event.id > fromSeq).map((event) => event.type);

const lastFinish = (store: FakeStore) => store.finishSession.mock.calls.at(-1)?.[2];

/** Run once with the driver failing to resolve: the run ends before it completes anything. */
async function failFirstRun(store: FakeStore, tree: Session, meta: ClaimedAgentSession) {
  mocks.resolveAgentDriverModel.mockRejectedValueOnce(
    new Error('The agent slot must not set thinking.effort'),
  );
  await runSession({ running: new Map(), shuttingDown: false }, meta);
  expect(lastFinish(store)).toMatchObject({ status: 'failed' });
  expect(await tree.getEntries()).toEqual([]);
  expect(store.delivered()).toBe(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentDriverModel.mockResolvedValue(DRIVER);
  mocks.createCallLlmStreamFn.mockReturnValue((() => {}) as never);
  mocks.getServerPersistenceProvider.mockResolvedValue({
    documentStore: { forOwner: () => ({}) },
  });
});

describe('a session whose first run failed before completing anything', () => {
  it('runs the next message, starting over with the opening message it was created with', async () => {
    const store = makeStore();
    const tree = await emptyTree();
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockImplementation(async () => tree.getStorage());

    // Created with an attached classroom: the opening message is durable.
    const courseRefs = [{ kind: 'course', stageId: 'stage-9', title: 'Fractions' }];
    const opening = store.postUserMessage('Move this course into a folder', { courseRefs });
    await failFirstRun(store, tree, makeMeta());

    const followUp = store.postUserMessage('Please try again');
    const received: string[] = [];
    mocks.buildAgent.mockImplementation(() => makeAgent(received));
    const before = store.events.length;
    await runSession({ running: new Map(), shuttingDown: false }, makeMeta({ attempt: 2 }));

    expect(lastFinish(store)).toMatchObject({ status: 'succeeded' });
    // The conversation resumes; it does not open a second time.
    expect(runTypes(store, before)[0]).toBe('session_resumed');
    expect(runTypes(store, before)).not.toContain('session_start');
    expect(received).toHaveLength(2);
    expect(received[0]).toContain('Fractions');
    expect(received[1]).toContain('Please try again');
    expect(store.markUserMessageDelivered.mock.calls.map((call) => call[3])).toEqual([
      opening,
      followUp,
    ]);
    const roles = (await tree.buildContext()).messages.map((message) => message.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('delivers a follow-up as itself when the session had no opening message', async () => {
    const store = makeStore();
    const tree = await emptyTree();
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockImplementation(async () => tree.getStorage());

    await failFirstRun(store, tree, makeMeta());

    const followUp = store.postUserMessage('Please try again');
    const received: string[] = [];
    mocks.buildAgent.mockImplementation(() => makeAgent(received));
    await runSession({ running: new Map(), shuttingDown: false }, makeMeta({ attempt: 2 }));

    expect(lastFinish(store)).toMatchObject({ status: 'succeeded' });
    // The session's own prompt opens the conversation, and the follow-up is
    // not mistaken for it (nor consumed in its place).
    expect(received).toEqual(['Build a lesson', expect.stringContaining('Please try again')]);
    expect(store.markUserMessageDelivered.mock.calls.map((call) => call[3])).toEqual([followUp]);
  });

  it('still refuses a tree that lost messages the event log shows were completed', async () => {
    const store = makeStore();
    const tree = await emptyTree();
    mocks.getAgentSessionStore.mockResolvedValue(store);
    mocks.openEntryStorage.mockImplementation(async () => tree.getStorage());
    const received: string[] = [];
    mocks.buildAgent.mockImplementation(() => makeAgent(received));

    await runSession({ running: new Map(), shuttingDown: false }, makeMeta());
    expect(lastFinish(store)).toMatchObject({ status: 'succeeded' });
    expect((await tree.getEntries()).length).toBeGreaterThan(0);

    // The tree is lost (here: a fresh, empty one) while the log keeps its run.
    const lost = await emptyTree();
    mocks.openEntryStorage.mockImplementation(async () => lost.getStorage());
    store.postUserMessage('Next step');
    received.length = 0;
    await runSession({ running: new Map(), shuttingDown: false }, makeMeta({ attempt: 2 }));

    expect(received).toEqual([]);
    expect(lastFinish(store)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('tree is empty although a prior run completed messages'),
    });
  });
});

describe('readPriorRunRecord', () => {
  const log = (types: string[]) => {
    const events = types.map((type, index) => ({
      id: index + 1,
      ts: index + 1,
      attempt: 1,
      type,
      data: {},
    }));
    const readEventsAfter = vi.fn(async (_id: string, after: number, limit = 500) =>
      events.filter((event) => event.id > after).slice(0, limit),
    );
    return { readEventsAfter };
  };

  it('reports no run for a session that never started', async () => {
    expect(await readPriorRunRecord(log(['user_message']), SESSION_ID)).toEqual({
      firstRunSeq: null,
      completedMessages: false,
    });
  });

  it('finds the first run and no completed message after a failed start', async () => {
    expect(
      await readPriorRunRecord(
        log(['user_message', 'session_start', 'session_end', 'user_message', 'session_resumed']),
        SESSION_ID,
      ),
    ).toEqual({ firstRunSeq: 2, completedMessages: false });
  });

  it('pages through a long log and stops at the first completed message', async () => {
    const types = [
      ...Array.from({ length: 600 }, () => 'trace'),
      'session_start',
      'message_end',
      ...Array.from({ length: 900 }, () => 'message_update'),
    ];
    const source = log(types);
    expect(await readPriorRunRecord(source, SESSION_ID)).toEqual({
      firstRunSeq: 601,
      completedMessages: true,
    });
    expect(source.readEventsAfter.mock.calls.map((call) => call[1])).toEqual([0, 500]);
  });
});
