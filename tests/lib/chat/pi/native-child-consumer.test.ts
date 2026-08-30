import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { AgentTurnSummary } from '@/lib/orchestration/types';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import type { NativeWebSearchConfig } from '@/lib/chat/pi/tools/web-search';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn(), searchWeb: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/web-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/web-search')>();
  return { ...actual, searchWeb: mocks.searchWeb };
});

import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const resolvedModel = { provider: 'test.provider', modelId: 'shared-model' };
const registeredSearchConfig: NativeWebSearchConfig = {
  providerId: 'tavily',
  apiKey: 'registered-search-key',
  baseUrl: 'https://registered-search.test',
};
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

function webSearchCall(query = 'current fact', toolCallId = 'search-1') {
  return {
    type: 'tool-call',
    toolCallId,
    toolName: 'web_search',
    input: { query },
  };
}

function rawWebSearchCall(input: unknown, toolCallId = 'search-invalid') {
  return {
    type: 'tool-call',
    toolCallId,
    toolName: 'web_search',
    input,
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

function elementReferenceEvidence(sceneId = 'scene-current', elementId = 'current-element') {
  return {
    content: `Selected element evidence: ${sceneId}/${elementId}`,
    metadata: {
      kind: 'slide_element' as const,
      source: 'request_start_snapshot' as const,
      sceneId,
      elementId,
      elementType: 'text' as const,
      geometry: { left: 0, top: 0, width: 100, height: 40, rotate: 0 },
      truncatedFields: [],
      omittedItems: {},
      content: { text: 'The key idea' },
    },
  };
}

function makeHarness(
  options: {
    evidence?: ReturnType<typeof sceneEvidence>;
    send?: (event: StatelessEvent) => Promise<void>;
    spotlightEnabled?: boolean;
    nativeWebSearchConfig?: NativeWebSearchConfig;
    takeSceneEvidence?: () => ReturnType<typeof sceneEvidence> | undefined;
    elementReferenceEvidence?: ReturnType<typeof elementReferenceEvidence>;
    agent?: AgentConfig;
    requestStartCurrentScene?: {
      sceneId: string;
      sceneType: string;
      elementIds: readonly string[];
    };
    body?: StatelessChatRequest;
    maxActionsPerAgent?: number;
    abortController?: AbortController;
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
    abortSignal: options.abortController?.signal ?? new AbortController().signal,
    maxAgentTurns: 3,
    getAgentTurnCount: () => summaries.length,
    getAgentResponses: () => summaries,
    getWhiteboardLedger: () => [],
    maxActionsPerAgent: options.maxActionsPerAgent ?? 8,
    enableWhiteboardTools: true,
    childRuntimeMode: 'native',
    enableNativeChildSpotlight: options.spotlightEnabled ?? true,
    nativeWebSearchConfig: options.nativeWebSearchConfig,
    requestStartCurrentScene:
      options.requestStartCurrentScene ??
      ({
        sceneId: 'scene-current',
        sceneType: 'slide',
        elementIds: ['current-element'],
      } as const),
    takeSceneEvidence: options.takeSceneEvidence ?? (() => options.evidence),
    elementReferenceEvidence: options.elementReferenceEvidence,
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
  beforeEach(() => {
    mocks.streamLLM.mockReset();
    mocks.searchWeb.mockReset();
  });

  it('rejects an invalid delegation before starting a grounded Child', async () => {
    const takeSceneEvidence = vi.fn(() => sceneEvidence());
    const harness = makeHarness({
      takeSceneEvidence,
      elementReferenceEvidence: elementReferenceEvidence(),
    });

    const result = await harness.tool.execute('invalid-delegate', {
      agentId: 'missing-agent',
      instruction: 'Must be rejected before evidence consumption.',
    });

    expect(takeSceneEvidence).not.toHaveBeenCalled();
    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ skipped: true, reason: 'invalid_agent_id' });
  });

  it('attaches the same request-scoped selected-element evidence to every Native delegation', async () => {
    useResponses([
      [{ type: 'text-delta', text: 'Grounded explanation.' }, finish('stop')],
      [finish('stop')],
    ]);
    const packet = elementReferenceEvidence();
    const harness = makeHarness({ elementReferenceEvidence: packet });

    const first = await execute(harness);
    const second = await execute(harness);

    expect(JSON.stringify(transportMessages(0))).toContain(
      'Selected element evidence: scene-current/current-element',
    );
    expect(JSON.stringify(transportMessages(1))).toContain(
      'Selected element evidence: scene-current/current-element',
    );
    expect(first.details).toMatchObject({ elementReferenceEvidence: packet.metadata });
    expect(second.details).toMatchObject({ elementReferenceEvidence: packet.metadata });
    expect(first.details).not.toHaveProperty('groundedChildSucceeded');
    expect(second.details).not.toHaveProperty('groundedChildSucceeded');
  });

  it('keeps a completed-empty selected-element turn in the ordinary Native lifecycle', async () => {
    useResponses([[finish('stop')]]);
    const harness = makeHarness({
      elementReferenceEvidence: elementReferenceEvidence(),
    });

    const result = await execute(harness);

    expect(result).not.toHaveProperty('isError');
    expect(result.details).toMatchObject({
      elementReferenceEvidence: expect.objectContaining({ elementId: 'current-element' }),
    });
    expect(result.details).not.toHaveProperty('groundedChildSucceeded');
  });

  it('authorizes only the same-scene selected element without read_scene evidence', async () => {
    useResponses([
      [spotlightCall('other-element'), finish('tool-calls')],
      [{ type: 'text-delta', text: 'Explaining without that Spotlight.' }, finish('stop')],
    ]);
    const harness = makeHarness({
      elementReferenceEvidence: elementReferenceEvidence(),
      requestStartCurrentScene: {
        sceneId: 'scene-current',
        sceneType: 'slide',
        elementIds: ['current-element', 'other-element'],
      },
    });

    const result = await execute(harness);

    expect(harness.events.some((event) => event.type === 'action')).toBe(false);
    expect(result.details).toMatchObject({
      elementReferenceEvidence: expect.objectContaining({ elementId: 'current-element' }),
    });
    expect(result.details).not.toHaveProperty('groundedChildSucceeded');
  });

  it('keeps cross-scene selected-element evidence fail-closed across Native delegations', async () => {
    useResponses([
      [{ type: 'text-delta', text: 'First grounded response.' }, finish('stop')],
      [{ type: 'text-delta', text: 'Second grounded response.' }, finish('stop')],
    ]);
    const packet = elementReferenceEvidence('scene-other', 'other-element');
    const harness = makeHarness({
      elementReferenceEvidence: packet,
      requestStartCurrentScene: {
        sceneId: 'scene-current',
        sceneType: 'slide',
        elementIds: ['current-element', 'other-element'],
      },
    });

    const first = await execute(harness);
    const second = await harness.tool.execute('delegate-2', {
      agentId: teacher.id,
      instruction: 'Continue from the same selected element.',
    });

    expect(JSON.stringify(transportMessages(0))).toContain(
      'Selected element evidence: scene-other/other-element',
    );
    expect(JSON.stringify(transportMessages(1))).toContain(
      'Selected element evidence: scene-other/other-element',
    );
    expect(first.details).toMatchObject({
      availableToolNames: ['web_search'],
      elementReferenceEvidence: packet.metadata,
    });
    expect(second.details).toMatchObject({
      availableToolNames: ['web_search'],
      elementReferenceEvidence: packet.metadata,
    });
    expect(harness.events.some((event) => event.type === 'action')).toBe(false);
  });

  it('consumes Scene evidence once even when the first valid Child fails', async () => {
    useResponses([
      [finish('error')],
      [{ type: 'text-delta', text: 'Second delegation without stale evidence.' }, finish('stop')],
    ]);
    let pendingScene: ReturnType<typeof sceneEvidence> | undefined = sceneEvidence();
    const takeSceneEvidence = vi.fn(() => {
      const evidence = pendingScene;
      pendingScene = undefined;
      return evidence;
    });
    const harness = makeHarness({
      takeSceneEvidence,
      elementReferenceEvidence: elementReferenceEvidence(),
    });

    const first = await execute(harness);
    const second = await harness.tool.execute('delegate-2', {
      agentId: teacher.id,
      instruction: 'Try again without reusing failed-turn evidence.',
    });

    expect(first).toMatchObject({
      isError: true,
      details: {
        sceneEvidence: [expect.objectContaining({ sceneId: 'scene-current' })],
      },
    });
    expect(second.details).not.toHaveProperty('sceneEvidence');
    expect(second.details).toMatchObject({ availableToolNames: ['spotlight', 'web_search'] });
    expect(takeSceneEvidence).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.streamLLM.mock.calls[0]?.[0])).toContain(
      'Scene evidence (sceneId=scene-current)',
    );
    expect(JSON.stringify(mocks.streamLLM.mock.calls[1]?.[0])).not.toContain(
      'Scene evidence (sceneId=scene-current)',
    );
    expect(JSON.stringify(mocks.streamLLM.mock.calls[0]?.[0])).toContain(
      'Selected element evidence: scene-current/current-element',
    );
    expect(JSON.stringify(mocks.streamLLM.mock.calls[1]?.[0])).toContain(
      'Selected element evidence: scene-current/current-element',
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
        availableToolNames: ['spotlight', 'web_search'],
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

    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).not.toHaveProperty(
      'spotlight',
    );
    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).toHaveProperty(
      'web_search',
    );
    expect(result).toMatchObject({
      details: {
        availableToolNames: ['web_search'],
        sceneEvidence: [expect.objectContaining({ sceneId: 'scene-other' })],
      },
    });
    expect(harness.events.some((event) => event.type === 'action')).toBe(false);
  });

  it('stays Native pure-text when the independent Spotlight flag is off', async () => {
    useResponses([[{ type: 'text-delta', text: 'Native speech only.' }, finish('stop')]]);
    const harness = makeHarness({ evidence: sceneEvidence(), spotlightEnabled: false });

    const result = await execute(harness);

    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).not.toHaveProperty(
      'spotlight',
    );
    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).toHaveProperty(
      'web_search',
    );
    expect(result).toMatchObject({
      details: {
        runtimeMode: 'native',
        availableToolNames: ['web_search'],
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

    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).not.toHaveProperty(
      'spotlight',
    );
    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).toHaveProperty(
      'web_search',
    );
    expect(result.details).toMatchObject({
      runtimeMode: 'native',
      availableToolNames: ['web_search'],
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
    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).not.toHaveProperty(
      'spotlight',
    );
    expect((mocks.streamLLM.mock.calls[0]?.[0] as { tools?: object }).tools).toHaveProperty(
      'web_search',
    );
    expect(result.details).toMatchObject({ availableToolNames: ['web_search'] });
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

  it('runs Native web_search in the same Child without classroom action accounting', async () => {
    mocks.searchWeb.mockResolvedValue({
      answer: 'A current fact.',
      query: 'current fact',
      responseTime: 0.1,
      sources: [
        {
          title: 'Exact source',
          url: 'https://example.test/current',
          content: 'Current evidence.',
          score: 1,
        },
      ],
    });
    useResponses([
      [webSearchCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'The current fact is supported.' }, finish('stop')],
    ]);
    const harness = makeHarness({
      nativeWebSearchConfig: registeredSearchConfig,
      agent: { ...teacher, allowedActions: [] },
    });

    const result = await execute(harness);
    const firstPayload = mocks.streamLLM.mock.calls[0]?.[0] as { tools: Record<string, unknown> };
    const continuation = transportMessages(1);
    const toolMessage = continuation.find(
      (message) => (message as { role?: string }).role === 'tool',
    ) as { content?: Array<{ output?: { type?: string; value?: string } }> } | undefined;

    expect(firstPayload.tools).toHaveProperty('web_search');
    expect(mocks.searchWeb).toHaveBeenCalledTimes(1);
    expect(toolMessage?.content?.[0]?.output?.type).toBe('text');
    expect(toolMessage?.content?.[0]?.output?.value).toContain('https://example.test/current');
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(harness.events.some((event) => event.type === 'action')).toBe(false);
    expect(result).toMatchObject({
      details: {
        availableToolNames: ['web_search'],
        nativeChildRun: {
          status: 'completed',
          attemptCount: 1,
          executionCount: 1,
          dispatchedActionCount: 0,
          providerTransportCount: 2,
        },
      },
    });
  });

  it('keeps not_configured as an error-text result and allows same-Child continuation', async () => {
    useResponses([
      [webSearchCall(), finish('tool-calls')],
      [{ type: 'text-delta', text: 'Search is unavailable right now.' }, finish('stop')],
    ]);
    const harness = makeHarness();

    const result = await execute(harness);
    const toolMessage = transportMessages(1).find(
      (message) => (message as { role?: string }).role === 'tool',
    ) as { content?: Array<{ output?: { type?: string } }> } | undefined;

    expect(mocks.searchWeb).not.toHaveBeenCalled();
    expect(toolMessage?.content?.[0]?.output?.type).toBe('error-text');
    expect(result).toMatchObject({
      details: {
        text: 'Search is unavailable right now.',
        nativeChildRun: { status: 'completed', attemptCount: 1, executionCount: 1 },
      },
    });
  });

  it('allows four searches and final speech on the fifth Child LLM transport', async () => {
    mocks.searchWeb.mockImplementation(async ({ query }) => ({
      answer: `Answer for ${query}`,
      query,
      responseTime: 0.1,
      sources: [
        {
          title: `Source for ${query}`,
          url: `https://example.test/${encodeURIComponent(query)}`,
          content: 'Evidence.',
          score: 1,
        },
      ],
    }));
    useResponses([
      [webSearchCall('query 1', 'search-1'), finish('tool-calls')],
      [webSearchCall('query 2', 'search-2'), finish('tool-calls')],
      [webSearchCall('query 3', 'search-3'), finish('tool-calls')],
      [webSearchCall('query 4', 'search-4'), finish('tool-calls')],
      [{ type: 'text-delta', text: 'Final sourced answer.' }, finish('stop')],
    ]);
    const harness = makeHarness({ nativeWebSearchConfig: registeredSearchConfig });

    const result = await execute(harness);

    expect(mocks.streamLLM).toHaveBeenCalledTimes(5);
    expect(mocks.searchWeb).toHaveBeenCalledTimes(4);
    expect(harness.onActionDone).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      details: {
        text: 'Final sourced answer.',
        nativeChildRun: {
          status: 'completed',
          attemptCount: 4,
          executionCount: 4,
          dispatchedActionCount: 0,
          providerTransportCount: 5,
        },
      },
    });
  });

  it('executes five distinct legal searches in one batch without a generic tool budget', async () => {
    mocks.searchWeb.mockImplementation(async ({ query }) => ({
      answer: `Answer for ${query}`,
      query,
      responseTime: 0.1,
      sources: [
        {
          title: `Source for ${query}`,
          url: `https://example.test/${encodeURIComponent(query)}`,
          content: 'Evidence.',
          score: 1,
        },
      ],
    }));
    useResponses([
      [
        ...Array.from({ length: 5 }, (_, index) =>
          webSearchCall(`query ${index + 1}`, `search-${index + 1}`),
        ),
        finish('tool-calls'),
      ],
      [{ type: 'text-delta', text: 'Five-source synthesis.' }, finish('stop')],
    ]);
    const harness = makeHarness({ nativeWebSearchConfig: registeredSearchConfig });

    const result = await execute(harness);

    expect(mocks.searchWeb).toHaveBeenCalledTimes(5);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      details: {
        text: 'Five-source synthesis.',
        nativeChildRun: {
          status: 'completed',
          attemptCount: 5,
          executionCount: 5,
          dispatchedActionCount: 0,
          providerTransportCount: 2,
        },
      },
    });
  });

  it('completes when a search continuation ends with an empty ordinary stop', async () => {
    mocks.searchWeb.mockResolvedValue({
      answer: 'Answer',
      query: 'current fact',
      responseTime: 0.1,
      sources: [
        { title: 'Source', url: 'https://example.test/source', content: 'Evidence.', score: 1 },
      ],
    });
    useResponses([[webSearchCall(), finish('tool-calls')], [finish('stop')]]);
    const harness = makeHarness({ nativeWebSearchConfig: registeredSearchConfig });

    const result = await execute(harness);

    expect(result).not.toHaveProperty('isError');
    expect(result).toMatchObject({
      details: {
        nativeChildRun: {
          status: 'completed',
          stopReason: 'stop',
          dispatchedActionCount: 0,
        },
      },
    });
  });

  it.each([
    ['whitespace query', { query: ' \n\t ' }],
    ['numeric query', { query: 1 }],
    ['boolean query', { query: true }],
    ['null query', { query: null }],
    ['nested query', { query: { value: 'current fact' } }],
    ['fractional maxResults', { query: 'current fact', maxResults: 1.5 }],
    ['string maxResults', { query: 'current fact', maxResults: '3' }],
    ['nested maxResults', { query: 'current fact', maxResults: { value: 3 } }],
    ['inherited query', Object.create({ query: 'current fact' })],
    [
      'inherited extra input',
      Object.assign(Object.create({ extra: true }), { query: 'current fact' }),
    ],
  ])('rejects %s before the Native search handler enters', async (_label, input) => {
    useResponses([
      [rawWebSearchCall(input), finish('tool-calls')],
      [{ type: 'text-delta', text: 'I cannot search without a query.' }, finish('stop')],
    ]);
    const harness = makeHarness({ nativeWebSearchConfig: registeredSearchConfig });

    const result = await execute(harness);
    const toolMessage = transportMessages(1).find(
      (message) => (message as { role?: string }).role === 'tool',
    ) as { content?: Array<{ output?: { type?: string } }> } | undefined;

    expect(mocks.searchWeb).not.toHaveBeenCalled();
    expect(toolMessage?.content?.[0]?.output?.type).toBe('error-text');
    expect(result).toMatchObject({
      details: { nativeChildRun: { attemptCount: 1, executionCount: 0 } },
    });
  });

  it('keeps length plus parsed web_search terminal and side-effect-free', async () => {
    useResponses([[webSearchCall(), finish('length')]]);
    const harness = makeHarness({ nativeWebSearchConfig: registeredSearchConfig });

    const result = await execute(harness);

    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(mocks.searchWeb).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: true,
      details: {
        nativeChildRun: {
          status: 'exhausted',
          stopReason: 'output_token_limit',
          attemptCount: 0,
          executionCount: 0,
          providerTransportCount: 1,
        },
      },
    });
  });

  it('terminates duplicate web_search IDs without replaying the search side effect', async () => {
    mocks.searchWeb.mockResolvedValue({
      answer: 'Answer',
      query: 'current fact',
      responseTime: 0.1,
      sources: [
        { title: 'Source', url: 'https://example.test/source', content: 'Evidence.', score: 1 },
      ],
    });
    useResponses([
      [webSearchCall('current fact', 'same-id'), finish('tool-calls')],
      [webSearchCall('current fact again', 'same-id'), finish('tool-calls')],
    ]);
    const harness = makeHarness({ nativeWebSearchConfig: registeredSearchConfig });

    const result = await execute(harness);

    expect(mocks.searchWeb).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isError: true,
      details: {
        nativeChildRun: {
          status: 'exhausted',
          stopReason: 'native_duplicate_tool_call',
          attemptCount: 2,
          executionCount: 1,
        },
      },
    });
  });

  it('performs zero Child transport and zero search request when already aborted', async () => {
    const abortController = new AbortController();
    abortController.abort(new DOMException('request already cancelled', 'AbortError'));
    const harness = makeHarness({ nativeWebSearchConfig: registeredSearchConfig, abortController });

    await expect(execute(harness)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(mocks.searchWeb).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    expect(harness.onActionDone).not.toHaveBeenCalled();
  });

  it('lets caller cancellation win while search is pending and starts no continuation', async () => {
    const abortController = new AbortController();
    mocks.searchWeb.mockImplementation(() => new Promise(() => {}));
    useResponses([[webSearchCall(), finish('tool-calls')]]);
    const harness = makeHarness({ nativeWebSearchConfig: registeredSearchConfig, abortController });

    const pending = execute(harness);
    await vi.waitFor(() => expect(mocks.searchWeb).toHaveBeenCalledTimes(1));
    abortController.abort(new DOMException('request cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
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
