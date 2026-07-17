import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const PI_CHAT_FLAG = 'NEXT_PUBLIC_PI_CHAT_ENABLED';
let originalPiChatFlag: string | undefined;

type MockTool = {
  name: string;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<unknown> | unknown;
};

type MockAgentOptions = {
  tools: MockTool[];
  afterToolCall?: (
    context: unknown,
  ) => { terminate?: boolean } | undefined | Promise<{ terminate?: boolean } | undefined>;
};

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  buildAgent: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModel: mocks.resolveModel,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    isProviderKeyRequired: vi.fn(() => false),
  };
});

vi.mock('@/lib/live-mode', () => ({
  isLiveMode: false,
}));

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
    debug: vi.fn(),
  }),
}));

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function makeBody() {
  return {
    messages: [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Explain city cooling.' }],
      },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'City Cooling', whiteboard: [] },
      scenes: [
        {
          id: 'scene-1',
          title: 'Cooling',
          type: 'slide',
          content: { type: 'slide', canvas: { elements: [] } },
        },
      ],
      currentSceneId: 'scene-1',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: {
      agentIds: ['default-1'],
      agentConfigs: [
        {
          id: 'default-1',
          name: 'Teacher',
          role: 'teacher',
          persona: 'You teach clearly.',
          priority: 10,
          avatar: '',
          color: '#3366ff',
          allowedActions: [],
        },
      ],
    },
    apiKey: '',
    model: 'test:model',
  };
}

function makeAgentConfig(opts: { id: string; name: string; role: string }) {
  return {
    id: opts.id,
    name: opts.name,
    role: opts.role,
    persona: `${opts.name} speaks briefly.`,
    priority: opts.role === 'teacher' ? 10 : 5,
    avatar: '',
    color: '#3366ff',
    allowedActions: [],
  };
}

async function readSseEvents(response: Response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice('data: '.length)));
}

function expectCueUserBeforeDone(events: Array<{ type: string }>) {
  const cueUserIndex = events.findIndex((event) => event.type === 'cue_user');
  const doneIndex = events.findIndex((event) => event.type === 'done');

  expect(cueUserIndex).toBeGreaterThanOrEqual(0);
  expect(doneIndex).toBeGreaterThanOrEqual(0);
  expect(cueUserIndex).toBeLessThan(doneIndex);
}

function mockDirectorWithAgentTurn(opts: { explicitlyCueUser: boolean; closeAfterCue?: boolean }) {
  mocks.buildAgent.mockImplementation((agentOpts: MockAgentOptions) => {
    const isDirector = agentOpts.tools.some((tool) => tool.name === 'cue_user');

    if (isDirector) {
      return {
        prompt: async () => {
          const callAgent = agentOpts.tools.find((tool) => tool.name === 'call_agent');
          const cueUser = agentOpts.tools.find((tool) => tool.name === 'cue_user');
          const closeSession = agentOpts.tools.find((tool) => tool.name === 'close_session');
          await callAgent?.execute('call-1', {
            agentId: 'default-1',
            instruction: 'Give one concise answer.',
          });
          if (opts.explicitlyCueUser) {
            await cueUser?.execute('cue-1', { prompt: 'Any follow-up?' });
          }
          if (opts.closeAfterCue) {
            await closeSession?.execute('close-1', { endReason: 'user_done' });
          }
        },
        waitForIdle: async () => {},
        subscribe: () => () => {},
        state: { messages: [] },
      };
    }

    return {
      subscribe: () => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      state: {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Cool roofs help.' }],
          },
        ],
      },
    };
  });
}

// Director calls the teacher once; the teacher child streams a structured-output
// array carrying a real whiteboard action, so this turn's ledger is non-empty.
function mockDirectorWithWhiteboardTeacherTurn(actionJson: string) {
  mocks.buildAgent.mockImplementation((agentOpts: MockAgentOptions) => {
    const isDirector = agentOpts.tools.some((tool) => tool.name === 'cue_user');

    if (isDirector) {
      return {
        prompt: async () => {
          const callAgent = agentOpts.tools.find((tool) => tool.name === 'call_agent');
          const cueUser = agentOpts.tools.find((tool) => tool.name === 'cue_user');
          await callAgent?.execute('call-1', {
            agentId: 'default-1',
            instruction: 'Draw the key point on the whiteboard.',
          });
          await cueUser?.execute('cue-1', { prompt: 'Any follow-up?' });
        },
        waitForIdle: async () => {},
        subscribe: () => () => {},
        state: { messages: [] },
      };
    }

    let handler: ((event: unknown) => unknown) | null = null;
    return {
      subscribe: (h: (event: unknown) => unknown) => {
        handler = h;
        return () => {};
      },
      prompt: async () => {
        await handler?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: actionJson },
        });
      },
      waitForIdle: async () => {},
      state: { messages: [] },
    };
  });
}

function mockDirectorWithTwoTeacherTurns() {
  mocks.buildAgent.mockImplementation((agentOpts: MockAgentOptions) => {
    const isDirector = agentOpts.tools.some((tool) => tool.name === 'cue_user');

    if (isDirector) {
      return {
        prompt: async () => {
          const callAgent = agentOpts.tools.find((tool) => tool.name === 'call_agent');
          const cueUser = agentOpts.tools.find((tool) => tool.name === 'cue_user');
          await callAgent?.execute('normal-1', {
            agentId: 'default-1',
            instruction: 'Give a normal answer.',
          });
          await callAgent?.execute('normal-2-over-local-limit', {
            agentId: 'default-1',
            instruction: 'This second normal turn should be skipped locally.',
          });
          await cueUser?.execute('cue-1', { prompt: 'Any follow-up?' });
        },
        waitForIdle: async () => {},
        subscribe: () => () => {},
        state: { messages: [] },
      };
    }

    return {
      subscribe: () => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      state: {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Fresh answer.' }],
          },
        ],
      },
    };
  });
}

function mockDirectorWithAgentThenCue(opts: {
  agentId: string;
  childText: string;
  cuePrompt?: string;
}) {
  mocks.buildAgent.mockImplementation((agentOpts: MockAgentOptions) => {
    const isDirector = agentOpts.tools.some((tool) => tool.name === 'cue_user');

    if (isDirector) {
      return {
        prompt: async () => {
          const callAgent = agentOpts.tools.find((tool) => tool.name === 'call_agent');
          const cueUser = agentOpts.tools.find((tool) => tool.name === 'cue_user');
          await callAgent?.execute('call-1', {
            agentId: opts.agentId,
            instruction: 'Give one concise answer.',
          });
          await cueUser?.execute('cue-1', { prompt: opts.cuePrompt ?? 'Any follow-up?' });
        },
        waitForIdle: async () => {},
        subscribe: () => () => {},
        state: { messages: [] },
      };
    }

    return {
      subscribe: () => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      state: {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: opts.childText }],
          },
        ],
      },
    };
  });
}

function mockDirectorCloseSessionWithoutTeacherTurn() {
  mocks.buildAgent.mockImplementation((agentOpts: MockAgentOptions) => {
    const isDirector = agentOpts.tools.some((tool) => tool.name === 'close_session');

    if (isDirector) {
      return {
        prompt: async () => {
          const closeSession = agentOpts.tools.find((tool) => tool.name === 'close_session');
          await closeSession?.execute('close-1', { endReason: 'user_done' });
        },
        waitForIdle: async () => {},
        subscribe: () => () => {},
        state: { messages: [] },
      };
    }

    return {
      subscribe: () => () => {},
      prompt: async () => {},
      waitForIdle: async () => {},
      state: { messages: [] },
    };
  });
}

function mockDirectorWithRejectedCalls(counter: { value: number }) {
  mocks.buildAgent.mockImplementation((agentOpts: MockAgentOptions) => ({
    prompt: async () => {
      const callAgent = agentOpts.tools.find((tool) => tool.name === 'call_agent');
      for (let i = 0; i < 20; i += 1) {
        const result = await callAgent?.execute(`invalid-${i}`, {
          agentId: 'missing-agent',
          instruction: 'Please answer.',
        });
        counter.value += 1;
        const guard = await agentOpts.afterToolCall?.({
          toolCall: { name: 'call_agent' },
          result,
        });
        if (guard?.terminate) break;
      }
    },
    waitForIdle: async () => {},
    subscribe: () => () => {},
    state: { messages: [] },
  }));
}

describe('POST /api/chat/pi cue_user', () => {
  beforeEach(() => {
    originalPiChatFlag = process.env[PI_CHAT_FLAG];
    process.env[PI_CHAT_FLAG] = 'true';
    vi.resetModules();
    mocks.resolveModel.mockReset();
    mocks.buildAgent.mockReset();
    mocks.createCallLlmStreamFn.mockReset();
    mocks.logError.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: { id: 'language-model' },
      apiKey: 'resolved-key',
      providerId: 'test-provider',
      modelInfo: { outputWindow: 4096 },
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
    mocks.createCallLlmStreamFn.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    if (originalPiChatFlag === undefined) {
      delete process.env[PI_CHAT_FLAG];
    } else {
      process.env[PI_CHAT_FLAG] = originalPiChatFlag;
    }
  });

  it('does not duplicate cue_user when coordinator explicitly cues before fallback', async () => {
    mockDirectorWithAgentTurn({ explicitlyCueUser: true });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(makeBody()));
    const events = await readSseEvents(response);

    const cueUserEvents = events.filter((event) => event.type === 'cue_user');
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(cueUserEvents).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'default-1', prompt: 'Any follow-up?' },
      },
    ]);
    expectCueUserBeforeDone(events);
    expect(doneEvent?.data.totalAgents).toBe(1);
    expect(doneEvent?.data.agentHadContent).toBe(true);
    expect(doneEvent?.data.directorState.agentResponses).toHaveLength(1);
    expect(doneEvent?.data.cueUserReceived).toBe(true);
  });

  it('keeps the session open when close_session follows cue_user in the same director turn', async () => {
    mockDirectorWithAgentTurn({ explicitlyCueUser: true, closeAfterCue: true });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(makeBody()));
    const events = await readSseEvents(response);
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(events.filter((event) => event.type === 'cue_user')).toHaveLength(1);
    expect(doneEvent?.data.cueUserReceived).toBe(true);
    expect(doneEvent?.data.sessionClosed).toBe(false);
    expect(doneEvent?.data.endReason).toBeUndefined();
  });

  it('falls back to cue_user before done when coordinator forgets to cue', async () => {
    mockDirectorWithAgentTurn({ explicitlyCueUser: false });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(makeBody()));
    const events = await readSseEvents(response);

    const cueUserEvents = events.filter((event) => event.type === 'cue_user');
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(cueUserEvents).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'default-1' },
      },
    ]);
    expectCueUserBeforeDone(events);
    expect(doneEvent?.data.totalAgents).toBe(1);
    expect(doneEvent?.data.agentHadContent).toBe(true);
    expect(doneEvent?.data.directorState.agentResponses).toHaveLength(1);
    expect(doneEvent?.data.cueUserReceived).toBe(true);
  });

  it('falls back to cue_user after a student-only turn', async () => {
    mockDirectorWithAgentThenCue({
      agentId: 'student-1',
      childText: 'I wonder if window placement changes airflow.',
      cuePrompt: 'Any follow-up?',
    });

    const body = makeBody();
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        ...body,
        config: {
          ...body.config,
          agentIds: ['student-1'],
          agentConfigs: [makeAgentConfig({ id: 'student-1', name: 'Student', role: 'student' })],
        },
      }),
    );
    const events = await readSseEvents(response);

    const cueUserEvents = events.filter((event) => event.type === 'cue_user');
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(cueUserEvents).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'student-1' },
      },
    ]);
    expect(doneEvent?.data.totalAgents).toBe(1);
    expect(doneEvent?.data.directorState.agentResponses).toEqual([
      expect.objectContaining({
        agentId: 'student-1',
        contentPreview: 'I wonder if window placement changes airflow.',
      }),
    ]);
    expect(doneEvent?.data.cueUserReceived).toBe(true);
  });

  it('allows explicit cue_user after a teacher substantive turn', async () => {
    mockDirectorWithAgentThenCue({
      agentId: 'default-1',
      childText: 'Cool roofs reduce heat by reflecting more sunlight.',
      cuePrompt: 'Any follow-up?',
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(makeBody()));
    const events = await readSseEvents(response);

    const cueUserEvents = events.filter((event) => event.type === 'cue_user');
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(cueUserEvents).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'default-1', prompt: 'Any follow-up?' },
      },
    ]);
    expect(doneEvent?.data.totalAgents).toBe(1);
    expect(doneEvent?.data.cueUserReceived).toBe(true);
  });

  it('allows explicit cue_user after a teaching assistant fallback substantive turn', async () => {
    mockDirectorWithAgentThenCue({
      agentId: 'assistant-1',
      childText: 'A cool roof reflects more sunlight, so the surface absorbs less heat.',
      cuePrompt: 'Any follow-up?',
    });

    const body = makeBody();
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        ...body,
        config: {
          ...body.config,
          agentIds: ['assistant-1'],
          agentConfigs: [
            makeAgentConfig({ id: 'assistant-1', name: 'Assistant', role: 'assistant' }),
          ],
        },
      }),
    );
    const events = await readSseEvents(response);

    const cueUserEvents = events.filter((event) => event.type === 'cue_user');
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(cueUserEvents).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'assistant-1', prompt: 'Any follow-up?' },
      },
    ]);
    expectCueUserBeforeDone(events);
    expect(doneEvent?.data.totalAgents).toBe(1);
    expect(doneEvent?.data.directorState.agentResponses).toEqual([
      expect.objectContaining({
        agentId: 'assistant-1',
        contentPreview: 'A cool roof reflects more sunlight, so the surface absorbs less heat.',
      }),
    ]);
    expect(doneEvent?.data.cueUserReceived).toBe(true);
  });

  it('rejects close_session when the current turn has no visible agent response', async () => {
    mockDirectorCloseSessionWithoutTeacherTurn();

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest(makeBody()));
    const events = await readSseEvents(response);

    const cueUserEvents = events.filter((event) => event.type === 'cue_user');
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(cueUserEvents).toEqual([]);
    expect(doneEvent?.data.sessionClosed).toBe(false);
    expect(doneEvent?.data.endReason).toBeUndefined();
    expect(doneEvent?.data.cueUserReceived).toBe(false);
  });

  it('terminates the director after the hard tool-call budget', async () => {
    const counter = { value: 0 };
    mockDirectorWithRejectedCalls(counter);

    const body = makeBody();
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        ...body,
        config: { ...body.config, piMaxAgentTurns: 1 },
      }),
    );
    const events = await readSseEvents(response);
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(counter.value).toBe(4);
    expect(doneEvent?.data.totalAgents).toBe(0);
    expect(doneEvent?.data.agentHadContent).toBe(false);
  });

  it('uses only this loop turn count for the normal turn cap', async () => {
    mockDirectorWithTwoTeacherTurns();

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        ...makeBody(),
        config: {
          ...makeBody().config,
          piMaxAgentTurns: 1,
        },
        directorState: {
          turnCount: 6,
          agentResponses: [
            {
              agentId: 'student-1',
              agentName: 'Student',
              contentPreview: 'I have one thought.',
              actionCount: 0,
              whiteboardActions: [],
            },
          ],
          whiteboardLedger: [],
        },
      }),
    );
    const events = await readSseEvents(response);

    const agentStarts = events.filter((event) => event.type === 'agent_start');
    const cueUserEvents = events.filter((event) => event.type === 'cue_user');
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    expect(agentStarts).toEqual([
      {
        type: 'agent_start',
        data: expect.objectContaining({ agentId: 'default-1', agentName: 'Teacher' }),
      },
    ]);
    expect(cueUserEvents).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'default-1', prompt: 'Any follow-up?' },
      },
    ]);
    expectCueUserBeforeDone(events);
    expect(doneEvent?.data.totalAgents).toBe(1);
    expect(doneEvent?.data.directorState.agentResponses).toHaveLength(2);
    expect(doneEvent?.data.directorState.agentResponses.at(-1)).toEqual(
      expect.objectContaining({
        agentId: 'default-1',
        contentPreview: 'Fresh answer.',
      }),
    );
    expect(doneEvent?.data.directorState.turnCount).toBe(1);
    expect(doneEvent?.data.directorState.teacherWrapUpUsed).toBeUndefined();
  });

  it('returns only this turn whiteboard ledger, not the carried-forward history', async () => {
    // This turn's teacher child streams a real wb_draw_text action, so the turn
    // ledger is non-empty. A DIFFERENT historical action arrives in directorState.
    // Cross-turn board state is carried by storeState's snapshot, and Pi child
    // prompts replay only the current-turn ledger, so the returned ledger must
    // contain this turn's action and drop the history — not grow unboundedly
    // across requests (and not collapse to a constant []).
    mockDirectorWithWhiteboardTeacherTurn(
      '[{"type":"action","name":"wb_draw_text","params":{"content":"from this turn","x":10,"y":20}},{"type":"text","content":"Here is the key point."}]',
    );

    const body = makeBody();
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        ...body,
        config: {
          ...body.config,
          piEnableWhiteboardTools: true,
          agentConfigs: [{ ...body.config.agentConfigs[0], allowedActions: ['wb_draw_text'] }],
        },
        directorState: {
          turnCount: 3,
          agentResponses: [],
          whiteboardLedger: [
            {
              actionName: 'wb_draw_text',
              agentId: 'default-1',
              agentName: 'Teacher',
              params: { content: 'from a previous turn', x: 0, y: 0 },
            },
          ],
        },
      }),
    );
    const events = await readSseEvents(response);
    const doneEvent = events.find((event) => event.type === 'done');

    expect(response.status).toBe(200);
    const returnedLedger = doneEvent?.data.directorState.whiteboardLedger;
    // Exactly this turn's action is kept...
    expect(returnedLedger).toEqual([
      expect.objectContaining({
        actionName: 'wb_draw_text',
        params: expect.objectContaining({ content: 'from this turn' }),
      }),
    ]);
    // ...and the carried-forward history is dropped.
    expect(
      returnedLedger.some(
        (record: { params?: { content?: string } }) =>
          record.params?.content === 'from a previous turn',
      ),
    ).toBe(false);
  });
});
