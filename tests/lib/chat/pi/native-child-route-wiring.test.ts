import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  streamLLM: vi.fn(),
  searchWeb: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/web-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/web-search')>();
  return { ...actual, searchWeb: mocks.searchWeb };
});
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return { ...actual, isProviderKeyRequired: vi.fn(() => false) };
});
vi.mock('@/lib/live-mode', () => ({ isLiveMode: false }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const resolvedModel = { provider: 'test.provider', modelId: 'openmaic-resolved-model' };
const envNames = [
  'NEXT_PUBLIC_PI_CHAT_ENABLED',
  'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME',
  'OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT',
  'TAVILY_API_KEY',
  'TAVILY_BASE_URL',
] as const;
const originalEnv = new Map<string, string | undefined>();

function finish(finishReason: string) {
  return { type: 'finish', finishReason, totalUsage: ZERO_USAGE };
}

function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'tool-call', toolCallId: id, toolName: name, input };
}

function resultFrom(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    usage: new Promise(() => {}),
  };
}

function makeRequest(overrides: Record<string, unknown> = {}): NextRequest {
  return new Request('http://localhost/api/chat/pi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Explain the highlighted idea.' }],
        },
      ],
      storeState: {
        stage: { id: 'stage-1', name: 'Native wiring', createdAt: 1, updatedAt: 2 },
        outlines: [],
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
                    id: 'evidence-element',
                    type: 'text',
                    content: 'The exact concept',
                    left: 20,
                    top: 30,
                    width: 240,
                    height: 60,
                  },
                ],
              },
            },
          },
        ],
        currentSceneId: 'scene-current',
        mode: 'autonomous',
        whiteboardOpen: false,
      },
      config: {
        agentIds: ['teacher-1'],
        agentConfigs: [
          {
            id: 'teacher-1',
            name: 'Teacher',
            role: 'teacher',
            persona: 'Teach from evidence.',
            avatar: '',
            color: '#3366ff',
            allowedActions: ['spotlight', 'laser', 'wb_open'],
            priority: 10,
          },
        ],
      },
      apiKey: '',
      model: 'test:model',
      webSearchProviderId: 'tavily',
      webSearchApiKey: 'toolbar-search-key',
      webSearchBaseUrl: 'https://api.tavily.com/search',
      ...overrides,
    }),
  }) as unknown as NextRequest;
}

async function readSseEvents(response: Response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice('data: '.length)));
}

describe('PR2 Native Child route production wiring', () => {
  beforeEach(() => {
    for (const name of envNames) originalEnv.set(name, process.env[name]);
    process.env.NEXT_PUBLIC_PI_CHAT_ENABLED = 'true';
    process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME = 'true';
    process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT = 'true';
    delete process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_BASE_URL;
    mocks.resolveModel.mockReset();
    mocks.streamLLM.mockReset();
    mocks.searchWeb.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: resolvedModel,
      apiKey: 'resolved-key',
      providerId: 'test-provider',
      modelInfo: { outputWindow: 512, contextWindow: 16_000 },
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
  });

  afterEach(() => {
    for (const name of envNames) {
      const value = originalEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originalEnv.clear();
    vi.resetModules();
  });

  it('executes read_scene → valid call_agent → Native Spotlight → same-Child continuation', async () => {
    const directorResponses = [
      [toolCall('read-1', 'read_scene', { sceneId: 'scene-current' }), finish('tool-calls')],
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Explain the exact current-slide concept.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Any question?' }), finish('tool-calls')],
    ];
    const childResponses = [
      [
        toolCall('spotlight-1', 'spotlight', { elementId: 'evidence-element' }),
        finish('tool-calls'),
      ],
      [{ type: 'text-delta', text: 'This exact element is the key.' }, finish('stop')],
    ];
    const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
    mocks.streamLLM.mockImplementation((options, source) => {
      payloads.push({ source, options });
      const parts =
        source === 'pi-chat-native-child' ? childResponses.shift() : directorResponses.shift();
      return resultFrom(parts ?? [{ type: 'text-delta', text: 'unexpected' }, finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest());
    const events = await readSseEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledTimes(1);
    expect(payloads).toHaveLength(5);
    expect(payloads.every((payload) => payload.options.model === resolvedModel)).toBe(true);
    expect(payloads.map((payload) => payload.source)).toEqual([
      'pi-chat-director',
      'pi-chat-director',
      'pi-chat-native-child',
      'pi-chat-native-child',
      'pi-chat-director',
    ]);

    const childPayloads = payloads.filter((payload) => payload.source === 'pi-chat-native-child');
    expect(JSON.stringify(childPayloads[0]?.options.messages)).toContain(
      'sceneId=scene-current, revision=2, source=request_start_snapshot',
    );
    expect(JSON.stringify(childPayloads[0]?.options.messages)).toContain('evidence-element');
    expect(childPayloads[0]?.options.tools).toHaveProperty('spotlight');
    expect(childPayloads[0]?.options.tools).toHaveProperty('web_search');
    expect(JSON.stringify(childPayloads[1]?.options.messages)).toContain('spotlight-1');
    expect(JSON.stringify(childPayloads[1]?.options.messages)).toContain(
      'Spotlight was accepted for best-effort dispatch.',
    );

    const action = events.find((event) => event.type === 'action');
    expect(action).toMatchObject({
      data: {
        actionName: 'spotlight',
        params: { elementId: 'evidence-element' },
        agentId: 'teacher-1',
      },
    });
    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ content: 'This exact element is the key.' }),
      }),
    ]);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      data: { totalAgents: 1, totalActions: 1, agentHadContent: true },
    });
  }, 15_000);

  it('keeps the production route on Legacy when the Native runtime flag is absent', async () => {
    delete process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME;
    delete process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT;
    const directorResponses = [
      [toolCall('read-1', 'read_scene', { sceneId: 'scene-current' }), finish('tool-calls')],
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Explain through the existing Legacy harness.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Any question?' }), finish('tool-calls')],
    ];
    const legacyChildResponses = [
      [
        {
          type: 'text-delta',
          text: '[{"type":"text","content":"Legacy response."}]',
        },
        finish('stop'),
      ],
    ];
    const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
    mocks.streamLLM.mockImplementation((options, source) => {
      payloads.push({ source, options });
      const parts =
        source === 'pi-chat-child' ? legacyChildResponses.shift() : directorResponses.shift();
      return resultFrom(parts ?? [{ type: 'text-delta', text: 'unexpected' }, finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest());
    const events = await readSseEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.resolveModel).toHaveBeenCalledTimes(1);
    expect(payloads.every((payload) => payload.options.model === resolvedModel)).toBe(true);
    expect(payloads.map((payload) => payload.source)).toEqual([
      'pi-chat-director',
      'pi-chat-director',
      'pi-chat-child',
      'pi-chat-director',
    ]);
    expect(payloads.some((payload) => payload.source === 'pi-chat-native-child')).toBe(false);
    expect(events.filter((event) => event.type === 'action')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ content: 'Legacy response.' }),
      }),
    ]);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      data: { totalAgents: 1, totalActions: 0, agentHadContent: true },
    });
  }, 15_000);

  it('keeps web_search exclusively in the Native Child inventory', async () => {
    const directorResponses = [
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Answer briefly.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Any question?' }), finish('tool-calls')],
    ];
    const childResponses = [[{ type: 'text-delta', text: 'Brief answer.' }, finish('stop')]];
    const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
    mocks.streamLLM.mockImplementation((options, source) => {
      payloads.push({ source, options });
      const parts =
        source === 'pi-chat-native-child' ? childResponses.shift() : directorResponses.shift();
      return resultFrom(parts ?? [{ type: 'text-delta', text: 'unexpected' }, finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(makeRequest());
    await readSseEvents(response);
    const directorPayload = payloads.find((payload) => payload.source === 'pi-chat-director');
    const childPayload = payloads.find((payload) => payload.source === 'pi-chat-native-child');

    expect(directorPayload?.options.tools).not.toHaveProperty('web_search');
    expect(childPayload?.options.tools).toHaveProperty('web_search');
  }, 15_000);

  it('rejects an unsupported Toolbar Web Search base URL before starting the Pi loop', async () => {
    const { POST } = await import('@/app/api/chat/pi/route');

    const response = await POST(
      makeRequest({ webSearchBaseUrl: 'https://evil.example.com/steal-key' }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: expect.stringContaining('Unsupported Tavily base URL') });
    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'uses the selected client key for an unmanaged provider',
      serverApiKey: undefined,
      serverBaseUrl: undefined,
      expectedApiKey: 'toolbar-search-key',
      expectedBaseUrl: 'https://api.tavily.com/search',
    },
    {
      label: 'keeps the server-managed key authoritative over a conflicting client key',
      serverApiKey: 'server-search-key',
      serverBaseUrl: 'http://internal-search.test/tavily',
      expectedApiKey: 'server-search-key',
      expectedBaseUrl: 'http://internal-search.test/tavily',
    },
  ])(
    '$label through the real Native route and same-Child continuation',
    async (testCase) => {
      if (testCase.serverApiKey) process.env.TAVILY_API_KEY = testCase.serverApiKey;
      if (testCase.serverBaseUrl) process.env.TAVILY_BASE_URL = testCase.serverBaseUrl;
      const directorResponses = [
        [
          toolCall('delegate-1', 'call_agent', {
            agentId: 'teacher-1',
            instruction: 'Search for the current fact and answer with its exact source.',
          }),
          finish('tool-calls'),
        ],
        [toolCall('cue-1', 'cue_user', { prompt: 'Any question?' }), finish('tool-calls')],
      ];
      const childResponses = [
        [
          toolCall('search-1', 'web_search', { query: 'current fact', maxResults: 3 }),
          finish('tool-calls'),
        ],
        [
          { type: 'text-delta', text: 'Current fact: https://example.test/current' },
          finish('stop'),
        ],
      ];
      const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
      mocks.searchWeb.mockResolvedValue({
        answer: 'The current fact.',
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
      mocks.streamLLM.mockImplementation((options, source) => {
        payloads.push({ source, options });
        const parts =
          source === 'pi-chat-native-child' ? childResponses.shift() : directorResponses.shift();
        return resultFrom(parts ?? [{ type: 'text-delta', text: 'unexpected' }, finish('stop')]);
      });

      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(makeRequest());
      const events = await readSseEvents(response);

      expect(response.status).toBe(200);
      expect(mocks.resolveModel).toHaveBeenCalledTimes(1);
      expect(mocks.searchWeb).toHaveBeenCalledTimes(1);
      expect(mocks.searchWeb).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'tavily',
          apiKey: testCase.expectedApiKey,
          baseUrl: testCase.expectedBaseUrl,
          query: 'current fact',
          maxResults: 3,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(payloads).toHaveLength(4);
      expect(payloads.every((payload) => payload.options.model === resolvedModel)).toBe(true);
      expect(payloads.map((payload) => payload.source)).toEqual([
        'pi-chat-director',
        'pi-chat-native-child',
        'pi-chat-native-child',
        'pi-chat-director',
      ]);

      const childPayloads = payloads.filter((payload) => payload.source === 'pi-chat-native-child');
      expect(payloads[0]?.options.tools).not.toHaveProperty('web_search');
      expect(childPayloads[0]?.options.tools).toHaveProperty('web_search');
      expect(JSON.stringify(childPayloads[1]?.options.messages)).toContain('search-1');
      expect(JSON.stringify(childPayloads[1]?.options.messages)).toContain(
        'https://example.test/current',
      );
      expect(JSON.stringify(payloads)).not.toContain('toolbar-search-key');
      expect(JSON.stringify(events)).not.toContain('toolbar-search-key');
      expect(JSON.stringify(payloads)).not.toContain('server-search-key');
      expect(JSON.stringify(events)).not.toContain('server-search-key');
      expect(events.filter((event) => event.type === 'action')).toHaveLength(0);
      expect(events.find((event) => event.type === 'done')).toMatchObject({
        data: { totalAgents: 1, totalActions: 0, agentHadContent: true },
      });
    },
    15_000,
  );
});
