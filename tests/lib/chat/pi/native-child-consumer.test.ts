import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const resolvedModel = { provider: 'test.provider', modelId: 'shared-model' };
const teacher: AgentConfig = {
  id: 'teacher-1',
  name: 'Teacher',
  role: 'teacher',
  persona: 'Teach from evidence.',
  avatar: '',
  color: '#3366ff',
  allowedActions: ['spotlight', 'laser', 'wb_open'],
  priority: 10,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  isDefault: true,
};

function finish(finishReason: string) {
  return { type: 'finish', finishReason, totalUsage: ZERO_USAGE };
}

function spotlightCall(elementId = 'current-element', toolCallId = 'spotlight-1') {
  return {
    type: 'tool-call',
    toolCallId,
    toolName: 'spotlight',
    input: { elementId, dimOpacity: 0.5 },
  };
}

function resultFrom(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    usage: new Promise(() => {}),
  };
}

function useResponses(responses: Array<Array<Record<string, unknown>>>) {
  mocks.streamLLM.mockImplementation(() =>
    resultFrom(responses.shift() ?? [{ type: 'text-delta', text: 'unexpected' }, finish('stop')]),
  );
}

function makeBody(): StatelessChatRequest {
  return {
    messages: [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Explain this element.' }] },
    ],
    storeState: {
      stage: { id: 'stage-1', name: 'Lesson', createdAt: 1, updatedAt: 2 },
      scenes: [
        {
          id: 'scene-current',
          stageId: 'stage-1',
          title: 'Current slide',
          order: 1,
          type: 'slide',
          content: {
            type: 'slide',
            canvas: {
              elements: [
                {
                  id: 'current-element',
                  type: 'text',
                  content: 'The key idea',
                  left: 0,
                  top: 0,
                  width: 100,
                  height: 40,
                },
              ],
            } as never,
          },
        },
      ],
      currentSceneId: 'scene-current',
      mode: 'autonomous',
      whiteboardOpen: false,
    },
    config: { agentIds: [teacher.id], agentConfigs: [teacher] },
    apiKey: '',
  } as StatelessChatRequest;
}

function sceneEvidence(sceneId = 'scene-current') {
  return {
    content: `Scene evidence (sceneId=${sceneId}): element id=current-element`,
    metadata: [
      {
        sceneId,
        title: sceneId,
        sceneType: 'slide',
        order: 1,
        revision: 'request-start',
        source: 'request_start_snapshot' as const,
      },
    ],
  };
}

function makeHarness(
  options: {
    evidence?: ReturnType<typeof sceneEvidence>;
    send?: (event: StatelessEvent) => Promise<void>;
    webEvidence?: {
      content: string;
      metadata: { query: string; retrievedAt: string; sourceCount: number };
    };
    spotlightEnabled?: boolean;
    takeSceneEvidence?: () => ReturnType<typeof sceneEvidence> | undefined;
    takeWebEvidence?: () =>
      | {
          content: string;
          metadata: { query: string; retrievedAt: string; sourceCount: number };
        }
      | undefined;
    agent?: AgentConfig;
    requestStartCurrentScene?: {
      sceneId: string;
      sceneType: string;
      elementIds: readonly string[];
    };
    body?: StatelessChatRequest;
    maxActionsPerAgent?: number;
  } = {},
) {
  const agent = options.agent ?? teacher;
  const events: StatelessEvent[] = [];
  const summaries: AgentTurnSummary[] = [];
  const onActionDone = vi.fn();
  const tool = buildCallAgentTool({
    body: options.body ?? makeBody(),
    agentConfigs: [agent],
    send:
      options.send ??
      (async (event) => {
        events.push(event);
      }),
    languageModel: resolvedModel as never,
    onAgentDone: (summary) => summaries.push(summary),
    onActionDone,
    thinkingConfig: { mode: 'disabled', enabled: false },
    maxOutputTokens: 384,
    abortSignal: new AbortController().signal,
    maxAgentTurns: 3,
    getAgentTurnCount: () => summaries.length,
    getAgentResponses: () => summaries,
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: options.maxActionsPerAgent ?? 8,
    enableWhiteboardTools: true,
    childRuntimeMode: 'native',
    enableNativeChildSpotlight: options.spotlightEnabled ?? true,
    requestStartCurrentScene:
      options.requestStartCurrentScene ??
      ({
        sceneId: 'scene-current',
        sceneType: 'slide',
        elementIds: ['current-element'],
      } as const),
    takeSceneEvidence: options.takeSceneEvidence ?? (() => options.evidence),
    takeWebEvidence: options.takeWebEvidence ?? (() => options.webEvidence),
  });
  return { events, summaries, onActionDone, tool };
}

async function execute(harness: ReturnType<typeof makeHarness>) {
  return harness.tool.execute('delegate-1', {
    agentId: teacher.id,
    instruction: 'Explain briefly and point to the key element.',
  });
}

function transportMessages(index: number) {
  return (mocks.streamLLM.mock.calls[index]?.[0] as { messages?: unknown[] })?.messages ?? [];
}

describe('Native Child production consumer', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('does not consume pending evidence for an invalid delegation', async () => {
    const takeSceneEvidence = vi.fn(() => sceneEvidence());
    const harness = makeHarness({ takeSceneEvidence });

    const result = await harness.tool.execute('invalid-delegate', {
      agentId: 'missing-agent',
      instruction: 'Must be rejected before evidence consumption.',
    });

    expect(takeSceneEvidence).not.toHaveBeenCalled();
    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ skipped: true, reason: 'invalid_agent_id' });
  });

  it('consumes Scene and Web evidence once even when the first valid Child fails', async () => {
    useResponses([
      [finish('error')],
      [{ type: 'text-delta', text: 'Second delegation without stale evidence.' }, finish('stop')],
    ]);
    let pendingScene: ReturnType<typeof sceneEvidence> | undefined = sceneEvidence();
    let pendingWeb:
      | {
          content: string;
          metadata: { query: string; retrievedAt: string; sourceCount: number };
        }
      | undefined = {
      content: 'Unique failed-turn source: https://example.test/consumed-once',
      metadata: {
        query: 'failed child evidence',
        retrievedAt: '2026-08-12T00:00:00.000Z',
        sourceCount: 1,
      },
    };
    const takeSceneEvidence = vi.fn(() => {
      const evidence = pendingScene;
      pendingScene = undefined;
      return evidence;
    });
    const takeWebEvidence = vi.fn(() => {
      const evidence = pendingWeb;
      pendingWeb = undefined;
      return evidence;
    });
    const harness = makeHarness({ takeSceneEvidence, takeWebEvidence });

    const first = await execute(harness);
    const second = await harness.tool.execute('delegate-2', {
      agentId: teacher.id,
      instruction: 'Try again without reusing failed-turn evidence.',
    });

    expect(first).toMatchObject({
      isError: true,
      details: {
        sceneEvidence: [expect.objectContaining({ sceneId: 'scene-current' })],
        webEvidence: expect.objectContaining({ query: 'failed child evidence' }),
      },
    });
    expect(second.details).not.toHaveProperty('sceneEvidence');
    expect(second.details).not.toHaveProperty('webEvidence');
    expect(second.details).toMatchObject({ availableToolNames: [] });
    expect(takeSceneEvidence).toHaveBeenCalledTimes(2);
    expect(takeWebEvidence).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.streamLLM.mock.calls[0]?.[0])).toContain('current-element');
    expect(JSON.stringify(mocks.streamLLM.mock.calls[0]?.[0])).toContain(
      'https://example.test/consumed-once',
    );
    expect(JSON.stringify(mocks.streamLLM.mock.calls[1]?.[0])).not.toContain('current-element');
    expect(JSON.stringify(mocks.streamLLM.mock.calls[1]?.[0])).not.toContain(
      'https://example.test/consumed-once',
    );
  });

  it('runs Spotlight and continuation in one Child through the shared OpenMAIC transport', async () => {
    useResponses([
      [spotlightCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'This is the key idea.' }, finish('stop')],
    ]);
    const harness = makeHarness({ evidence: sceneEvidence() });

    const result = await execute(harness);

    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(mocks.streamLLM.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: resolvedModel, maxOutputTokens: 384 }),
    );
    expect(mocks.streamLLM.mock.calls[0]?.[1]).toBe('pi-chat-native-child');
    expect(transportMessages(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant' }),
        expect.objectContaining({
          role: 'tool',
          content: [
            expect.objectContaining({
              toolCallId: 'spotlight-1',
              toolName: 'spotlight',
              output: { type: 'text', value: expect.stringContaining('best-effort') },
            }),
          ],
        }),
      ]),
    );
    expect(harness.events.filter((event) => event.type === 'action')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(harness.onActionDone).toHaveBeenCalledTimes(1);
    expect(harness.summaries).toEqual([
      expect.objectContaining({ contentPreview: 'This is the key idea.', actionCount: 1 }),
    ]);
    expect(result).not.toHaveProperty('isError');
    expect(result).toMatchObject({
      details: {
        runtimeMode: 'native',
        availableToolNames: ['spotlight'],
        text: 'This is the key idea.',
        sceneEvidence: [expect.objectContaining({ sceneId: 'scene-current' })],
        nativeChildRun: {
          status: 'completed',
          attemptCount: 1,
          executionCount: 1,
          dispatchedActionCount: 1,
          providerTransportCount: 2,
        },
      },
    });
  });

  it('does not use the Legacy action limit as a Native execution budget', async () => {
    useResponses([
      [spotlightCall('current-element', 'spotlight-1'), finish('tool-calls')],
      [spotlightCall('current-element', 'spotlight-2'), finish('tool-calls')],
      [{ type: 'text-delta', text: 'Both pointers were accepted.' }, finish('stop')],
    ]);
    const harness = makeHarness({
      evidence: sceneEvidence(),
      maxActionsPerAgent: 1,
    });

    const result = await execute(harness);

    expect(mocks.streamLLM).toHaveBeenCalledTimes(3);
    expect(harness.events.filter((event) => event.type === 'action')).toHaveLength(2);
    expect(harness.onActionDone).toHaveBeenCalledTimes(2);
    expect(result).not.toHaveProperty('isError');
    expect(result).toMatchObject({
      details: {
        text: 'Both pointers were accepted.',
        nativeChildRun: {
          status: 'completed',
          attemptCount: 2,
          executionCount: 2,
          dispatchedActionCount: 2,
          providerTransportCount: 3,
        },
      },
    });
  });

  it('allows action-only completion without emitting fabricated text', async () => {
    useResponses([[spotlightCall(), finish('tool-calls')], [finish('stop')]]);
    const harness = makeHarness({ evidence: sceneEvidence() });

    const result = await execute(harness);

    expect(harness.events.filter((event) => event.type === 'text_delta')).toEqual([]);
    expect(harness.summaries).toEqual([
      expect.objectContaining({ contentPreview: '', actionCount: 1 }),
    ]);
    expect(result).toMatchObject({
      details: { text: '', nativeChildRun: { status: 'completed' } },
    });
  });

  it('does not register Spotlight without consumed evidence for the captured current Scene', async () => {
    useResponses([[{ type: 'text-delta', text: 'Speech only.' }, finish('stop')]]);
    const harness = makeHarness({ evidence: sceneEvidence('scene-other') });

    const result = await execute(harness);

    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).toEqual({});
    expect(result).toMatchObject({
      details: {
        availableToolNames: [],
        sceneEvidence: [expect.objectContaining({ sceneId: 'scene-other' })],
      },
    });
    expect(harness.events.some((event) => event.type === 'action')).toBe(false);
  });

  it('stays Native pure-text when the independent Spotlight flag is off', async () => {
    useResponses([[{ type: 'text-delta', text: 'Native speech only.' }, finish('stop')]]);
    const harness = makeHarness({ evidence: sceneEvidence(), spotlightEnabled: false });

    const result = await execute(harness);

    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).toEqual({});
    expect(result).toMatchObject({
      details: {
        runtimeMode: 'native',
        availableToolNames: [],
        nativeChildRun: { status: 'completed' },
      },
    });
  });

  it('streams Native visible text deltas incrementally in provider order', async () => {
    useResponses([
      [
        { type: 'text-delta', text: 'First ' },
        { type: 'text-delta', text: 'second.' },
        finish('stop'),
      ],
    ]);
    const harness = makeHarness({ evidence: sceneEvidence() });

    const result = await execute(harness);

    expect(result).not.toHaveProperty('isError');
    expect(result).toMatchObject({
      details: { text: 'First second.', nativeChildRun: { status: 'completed' } },
    });
    expect(
      harness.events.filter((event) => event.type === 'text_delta').map((event) => event.data),
    ).toEqual([
      { content: 'First ', messageId: expect.any(String) },
      { content: 'second.', messageId: expect.any(String) },
    ]);
  });

  it('does not let runtime selection grant Spotlight outside effective Agent capability', async () => {
    useResponses([[{ type: 'text-delta', text: 'Capability-filtered speech.' }, finish('stop')]]);
    const harness = makeHarness({
      evidence: sceneEvidence(),
      agent: { ...teacher, allowedActions: ['laser', 'wb_open'] },
    });

    const result = await execute(harness);

    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).toEqual({});
    expect(result.details).toMatchObject({
      runtimeMode: 'native',
      availableToolNames: [],
    });
  });

  it('does not register Spotlight when the request-start current Scene is not a slide', async () => {
    useResponses([[{ type: 'text-delta', text: 'No slide pointing.' }, finish('stop')]]);
    const harness = makeHarness({
      evidence: sceneEvidence(),
      requestStartCurrentScene: {
        sceneId: 'scene-current',
        sceneType: 'quiz',
        elementIds: ['current-element'],
      },
    });

    const result = await execute(harness);
    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).toEqual({});
    expect(result.details).toMatchObject({ availableToolNames: [] });
  });

  it('does not instantiate or read the Legacy whiteboard shadow state', async () => {
    useResponses([[{ type: 'text-delta', text: 'Native without Legacy shadow.' }, finish('stop')]]);
    const body = makeBody();
    Object.defineProperty(body.storeState, 'whiteboardOpen', {
      configurable: true,
      get: () => {
        throw new Error('Legacy whiteboard state was instantiated');
      },
    });
    const harness = makeHarness({ body });

    await expect(execute(harness)).resolves.toMatchObject({
      details: { runtimeMode: 'native' },
    });
  });

  it('keeps Director Web evidence as untrusted prompt data without a Child web_search tool', async () => {
    useResponses([[{ type: 'text-delta', text: 'Evidence-backed speech.' }, finish('stop')]]);
    const harness = makeHarness({
      webEvidence: {
        content: 'Exact source: https://example.test/source',
        metadata: {
          query: 'current fact',
          retrievedAt: '2026-08-12T00:00:00.000Z',
          sourceCount: 1,
        },
      },
    });

    const result = await execute(harness);
    const firstPayload = mocks.streamLLM.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
      tools: Record<string, unknown>;
    };
    expect(JSON.stringify(firstPayload.messages)).toContain('https://example.test/source');
    expect(firstPayload.tools).not.toHaveProperty('web_search');
    expect(result.details).toMatchObject({ webEvidence: { query: 'current fact' } });
  });

  it('does not count a rejected Spotlight dispatch and returns error-text to the same Child', async () => {
    useResponses([
      [spotlightCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'I could not dispatch it.' }, finish('stop')],
    ]);
    const events: StatelessEvent[] = [];
    const harness = makeHarness({
      evidence: sceneEvidence(),
      send: async (event) => {
        if (event.type === 'action') throw new Error('writer rejected');
        events.push(event);
      },
    });

    const result = await execute(harness);
    const toolMessage = transportMessages(1).find(
      (message) => (message as { role?: string }).role === 'tool',
    ) as { content?: Array<{ output?: { type?: string } }> } | undefined;

    expect(toolMessage?.content?.[0]?.output?.type).toBe('error-text');
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(harness.summaries).toEqual([
      expect.objectContaining({ actionCount: 0, contentPreview: 'I could not dispatch it.' }),
    ]);
    expect(result.details).toMatchObject({
      nativeChildRun: { status: 'completed', dispatchedActionCount: 0 },
    });
  });

  it('consumes the merged length gate without executing a parsed Spotlight call', async () => {
    useResponses([[spotlightCall(), finish('length')]]);
    const harness = makeHarness({ evidence: sceneEvidence() });

    const result = await execute(harness);

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(harness.events.some((event) => event.type === 'action')).toBe(false);
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: {
        nativeChildRun: {
          status: 'exhausted',
          stopReason: 'output_token_limit',
          attemptCount: 0,
          executionCount: 0,
          dispatchedActionCount: 0,
          providerTransportCount: 1,
        },
      },
    });
  });

  it('rejects the Native-only empty elementId schema without entering the handler', async () => {
    useResponses([
      [spotlightCall(''), finish('tool-calls')],
      [{ type: 'text-delta', text: 'I will explain without pointing.' }, finish('stop')],
    ]);
    const harness = makeHarness({ evidence: sceneEvidence() });

    const result = await execute(harness);
    const toolMessage = transportMessages(1).find(
      (message) => (message as { role?: string }).role === 'tool',
    ) as { content?: Array<{ output?: { type?: string } }> } | undefined;

    expect(toolMessage?.content?.[0]?.output?.type).toBe('error-text');
    expect(harness.events.some((event) => event.type === 'action')).toBe(false);
    expect(result.details).toMatchObject({
      nativeChildRun: { attemptCount: 1, executionCount: 0, dispatchedActionCount: 0 },
    });
  });
});
