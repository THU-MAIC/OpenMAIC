/**
 * Runner per-session NOTIFY wakeup wiring (hermetic unit port of the
 * reference's runner-notify PG contract).
 *
 * What is pinned here, with a REAL `runSession` loop and a fake Agent:
 *
 *  1. the runner registers exactly ONE `{kind:'session'}` wakeup subscription
 *     per run and removes it when the run ends (no leaked subscription);
 *  2. a session-route wake runs BOTH cheap point reads — `isCancelRequested`
 *     (the cancel check) and the drain (`listUserMessages`) — so a user
 *     message written by the control plane is steered into the live agent in
 *     the hundreds-of-ms range instead of on the 5s fallback poll;
 *  3. the 5s message/cancel polls stay as the lossy-NOTIFY backstop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // The drain refuses to steer without a matching lease, and WORKER_ID is a
  // random-per-process value. Capture it from the first appendRunEvent call
  // (the runner passes WORKER_ID as its second argument) and hand it back
  // through getSession so `leaseMatches` sees a live, owned session.
  let workerId: string | undefined;
  const store = {
    appendRunEvent: vi.fn(async (_id: string, worker: string) => {
      workerId = worker;
      return 1;
    }),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () =>
      workerId
        ? {
            id: 'session-wake',
            ownerId: 'owner-1',
            status: 'running',
            attempt: 1,
            lease: { workerId, workerPid: process.pid, heartbeatAt: Date.now() },
          }
        : null,
    ),
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    getCancelRequestedAt: vi.fn(async () => null),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(
      async (): Promise<
        Array<{ seq: number; ts: number; text: string; delivery: string; materials: unknown[] }>
      > => [],
    ),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
  const bus = {
    route: undefined as undefined | { kind: string; sessionId: string },
    wake: undefined as undefined | (() => void),
    unsubscribeWakeup: vi.fn(),
  };
  return { store, bus, resetWorker: () => (workerId = undefined) };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: vi.fn(async () => mocks.store),
}));

vi.mock('@/lib/server/agent-runtime/event-notify-bus', () => ({
  subscribeAgentEventWakeup: vi.fn(
    (route: { kind: string; sessionId: string }, wake: () => void) => {
      mocks.bus.route = route;
      mocks.bus.wake = wake;
      return mocks.bus.unsubscribeWakeup;
    },
  ),
}));

// The runner lists the session's materials to build the materials prompt
// block. No material store exists in this harness; an empty list keeps the
// prompt free of the block while the real tool builders stay loaded.
vi.mock('@/lib/server/agent-runtime/session-materials', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return { ...actual, listSessionMaterials: vi.fn(async () => []) };
});

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  const { InMemorySessionRepo } = await import('@earendil-works/pi-agent-core');
  return {
    ...actual,
    AgentSessionEntryStorage: {
      open: async ({ sessionId }: { sessionId: string }) =>
        (await new InMemorySessionRepo().create({ id: sessionId })).getStorage(),
    },
  };
});

// No installed skills and no user-skill store: the skill surface is
// orthogonal to the wakeup under test.
vi.mock('@/lib/server/agent-runtime/skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/skills')>();
  return {
    ...actual,
    listSkills: vi.fn(async () => []),
    findSkill: vi.fn(async () => null),
  };
});
vi.mock('@/lib/server/agent-runtime/user-skills', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/user-skills')>();
  return { ...actual, listUserSkills: vi.fn(async () => []) };
});

// The owner-bound document store is setup-only in this harness; the tools
// built around it are never invoked.
vi.mock('@/lib/server/agent-runtime/owner-scoped-documents', () => ({
  getOwnerScopedDocumentStore: vi.fn(async () => ({})),
}));

// Capability resolution stays hermetic: no web search and no voice
// registration backend in this harness.
vi.mock('@/lib/server/agent-runtime/web-search', () => ({
  resolveWebSearchCapability: () => null,
}));
vi.mock('@/lib/server/agent-runtime/voice-clone-tools', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/voice-clone-tools')>();
  return { ...actual, hasConfiguredVoiceRegistrationCapability: () => false };
});

// A resolvable driver model with a no-op streamFn: the fake Agent below never
// reads the stream, so nothing touches a real model gateway.
vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: vi.fn(async () => ({
    connection: { model: { id: 'wakeup-test' }, modelId: 'wakeup-test', providerId: 'test' },
    piModel: {
      id: 'wakeup-test',
      name: 'wakeup-test',
      api: 'openai-completions',
      provider: 'test',
      baseUrl: '',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8_192,
  })),
}));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: vi.fn(() => async () => undefined),
}));

/**
 * The fake Agent the runner constructs. `prompt` stays pending until the test
 * releases it (or an abort fires), keeping the session "running" while
 * messages/cancels are injected through the wakeup. A steered message is
 * folded into the entry tree via message_end so the runner's post-settle
 * undelivered-message check counts it as delivered.
 */
const fake = vi.hoisted(() => {
  class FakeAgent {
    state: { messages: unknown[]; errorMessage?: string } = { messages: [] };
    steerCalls: Array<{ role: string; content: unknown }> = [];
    promptCalls = 0;
    abortCalls = 0;
    private subscribers = new Set<(event: unknown) => void>();
    private release: (() => void) | null = null;

    reset(): void {
      this.state = { messages: [] };
      this.steerCalls = [];
      this.promptCalls = 0;
      this.abortCalls = 0;
      this.subscribers = new Set();
      this.release = null;
    }

    subscribe(cb: (event: unknown) => void): () => void {
      this.subscribers.add(cb);
      return () => this.subscribers.delete(cb);
    }

    abort(): void {
      this.abortCalls += 1;
      this.release?.();
    }

    /** Test hook: let the pending prompt resolve so the run can settle. */
    releasePrompt(): void {
      this.release?.();
      this.release = null;
    }

    clearAllQueues(): void {
      // buildAgent's terminal-barrier hook only calls this on a length stop,
      // which this harness never produces.
    }

    async prompt(text: string): Promise<void> {
      this.promptCalls += 1;
      // The prompt becomes the first user message of the conversation (real pi
      // behaviour) — folded into the entry tree via message_end so the
      // runner's post-settle undelivered-message check counts it as delivered.
      this.state.messages.push({ role: 'user', content: text });
      this.emitMessageEnd({ role: 'user', content: text });
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }

    async continue(): Promise<void> {
      await this.prompt('');
    }

    async followUp(message: { role: string; content: unknown }): Promise<void> {
      await this.prompt(String((message as { content?: unknown })?.content ?? ''));
    }

    async waitForIdle(): Promise<void> {
      // Idle immediately after prompt resolves; the drain loop then drains and
      // settles. A blocked prompt never reaches here.
    }

    steer(message: { role: string; content: unknown }): void {
      this.steerCalls.push(message);
      this.state.messages.push(message);
      this.emitMessageEnd(message);
    }

    private emitMessageEnd(message: { role: string; content: unknown }): void {
      const event = { type: 'message_end', message };
      for (const cb of [...this.subscribers]) cb(event);
    }
  }

  const current: { instance?: FakeAgent } = {};
  return { FakeAgent, current };
});

vi.mock('@earendil-works/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-agent-core')>();
  class MockAgent extends fake.FakeAgent {
    constructor() {
      super();
      // The runner constructs exactly one Agent per run; expose it so tests can
      // wait for the run to reach the prompt and observe its steer/abort.
      fake.current.instance = this;
    }
  }
  return { ...actual, Agent: MockAgent };
});

import { runSession } from '@/lib/server/agent-runtime/runner';

const SESSION = {
  id: 'session-wake',
  ownerId: 'owner-1',
  prompt: 'Build a lesson',
  stageId: 'stage-1',
  existingCourse: false,
  status: 'running' as const,
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
  claimReason: 'queued' as const,
  claimSeq: 0,
};

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // The run must be parked on the pending prompt AND its lease captured
    // (the worker id is learned from the first appendRunEvent call, which the
    // runner queues on its write chain before reaching the prompt). Without
    // the lease the drain would refuse to steer.
    if (
      fake.current.instance &&
      fake.current.instance.promptCalls > 0 &&
      mocks.store.appendRunEvent.mock.calls.length > 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run never reached a ready state');
}

describe('runSession NOTIFY wakeup wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.current.instance?.reset();
    fake.current.instance = undefined;
    mocks.resetWorker();
    mocks.bus.route = undefined;
    mocks.bus.wake = undefined;
    mocks.store.listUserMessages.mockResolvedValue([]);
  });

  it('subscribes to the session route, wakes the cancel check and drain, and unsubscribes on settle', async () => {
    const run = runSession({ running: new Map(), shuttingDown: false }, SESSION);
    await waitForReady();

    expect(mocks.bus.route).toEqual({ kind: 'session', sessionId: 'session-wake' });
    expect(mocks.bus.wake).toBeTypeOf('function');

    // A user message lands on the control plane; the SAME wake that fired for
    // it must drain it into the live agent immediately — no 5s fallback poll.
    mocks.store.listUserMessages.mockResolvedValueOnce([
      { seq: 2, ts: 1, text: 'follow-up from the control plane', delivery: 'steer', materials: [] },
    ]);
    mocks.bus.wake?.();
    await vi.waitFor(() => {
      expect(fake.current.instance?.steerCalls).toEqual([
        { role: 'user', content: 'follow-up from the control plane' },
      ]);
    });
    // The wake runs BOTH cheap point reads: the drain above and the cancel
    // check — one shared subscription, two checks (reference semantics).
    expect(mocks.store.listUserMessages).toHaveBeenCalledWith('session-wake');
    expect(mocks.store.getCancelRequestedAt).toHaveBeenCalled();

    // Release the pending prompt and let the run settle; the subscription must
    // go away with it.
    fake.current.instance?.releasePrompt();
    await run;
    expect(mocks.bus.unsubscribeWakeup).toHaveBeenCalledOnce();
  });

  it('still unsubscribes when setup fails before the agent is built', async () => {
    // A driver-model failure kills the run during setup — the wakeup
    // subscription created before the try must still be cleaned up.
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    vi.mocked(resolveAgentDriverModel).mockRejectedValueOnce(new Error('driver unavailable'));

    await runSession({ running: new Map(), shuttingDown: false }, SESSION);

    expect(mocks.bus.route).toEqual({ kind: 'session', sessionId: 'session-wake' });
    expect(mocks.bus.unsubscribeWakeup).toHaveBeenCalledOnce();
  });
});
