import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { NextRequest } from 'next/server';
import type { RuntimeRecord } from '@openmaic/dsl';
import { BrowserRuntimeStore } from '@openmaic/storage';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { configureOwnerAuthentication } from '@/lib/server/identity';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  streamLLM: vi.fn(),
  searchWeb: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  stageMetaQuery: vi.fn(),
  previewFetch: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
// Model settings are the resolver's business (tests/server/model-config); the
// persistence assertions below are about the whiteboard inventory alone.
vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/runtime')>()),
  requestWorkspaceId: async () => null,
}));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.previewFetch }));
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
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));
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
  'OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME',
  'OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT',
  'TAVILY_API_KEY',
  'TAVILY_BASE_URL',
  'DATABASE_URL',
  'RENDER_SERVICE_URL',
] as const;

/** The owner the route requests resolve to; its id is the runtime learner key. */
const OWNER_COOKIE = '88888888-8888-4888-8888-888888888888';
const LEARNER_KEY = `anon:${OWNER_COOKIE}`;
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

function makeRequest(
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = { cookie: `anonymous_id=${OWNER_COOKIE}` },
): NextRequest {
  return new Request('http://localhost/api/chat/pi', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
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

function rejectOwnerCredentials(): void {
  resetOwnerAuthenticationForTests();
  configureOwnerAuthentication({
    methods: [{ name: 'rejecting', authenticate: async () => ({ status: 'invalid' }) }],
  });
}

describe('PR2 Native Child route production wiring', () => {
  beforeEach(() => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    for (const name of envNames) originalEnv.set(name, process.env[name]);
    process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME = 'true';
    process.env.OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT = 'true';
    delete process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_BASE_URL;
    delete process.env.RENDER_SERVICE_URL;
    mocks.previewFetch.mockReset();
    mocks.resolveModel.mockReset();
    mocks.streamLLM.mockReset();
    mocks.searchWeb.mockReset();
    mocks.getServerPersistenceProvider.mockReset();
    mocks.stageMetaQuery.mockReset();
    // No stage_meta row: a course this server never stored, never tombstoned.
    mocks.stageMetaQuery.mockResolvedValue({ rows: [] });
    mocks.getServerPersistenceProvider.mockResolvedValue({
      pool: { query: mocks.stageMetaQuery },
      runtimeStore: new BrowserRuntimeStore({
        indexedDB: new IDBFactory(),
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      }),
    });
    mocks.resolveModel.mockResolvedValue({
      model: resolvedModel,
      apiKey: 'resolved-key',
      providerId: 'test-provider',
      modelInfo: { outputWindow: 512, contextWindow: 16_000 },
      thinkingConfig: { mode: 'disabled', enabled: false },
    });
  });

  afterEach(() => {
    resetOwnerAuthenticationForTests();
    for (const name of envNames) {
      const value = originalEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originalEnv.clear();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does not advance the sequence of sibling writes in one Child reply', async () => {
    process.env.DATABASE_URL = 'postgres://shared-provider-test';
    const directorResponses = [
      [
        toolCall('delegate', 'call_agent', { agentId: 'teacher-1', instruction: 'Draw labels.' }),
        finish('tool-calls'),
      ],
      [finish('stop')],
    ];
    const childResponses = [
      [toolCall('read', 'wb_read', {}), finish('tool-calls')],
      [
        toolCall('a', 'wb_draw_text', { expectedLastSeq: null, content: 'A', x: 0, y: 0 }),
        toolCall('b', 'wb_draw_text', { expectedLastSeq: null, content: 'B', x: 0, y: 50 }),
        finish('tool-calls'),
      ],
      [{ type: 'text-delta', text: 'One label was added.' }, finish('stop')],
    ];
    const childPayloads: unknown[] = [];
    mocks.streamLLM.mockImplementation((options, source) => {
      if (source === 'pi-chat-native-child') childPayloads.push(options.messages);
      return resultFrom(
        (source === 'pi-chat-native-child' ? childResponses : directorResponses).shift() ?? [
          finish('stop'),
        ],
      );
    });
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        config: {
          agentIds: ['teacher-1'],
          piEnableWhiteboardTools: true,
          agentConfigs: [
            {
              id: 'teacher-1',
              name: 'Teacher',
              role: 'teacher',
              persona: 'Teach clearly.',
              avatar: '',
              color: '#3366ff',
              allowedActions: ['wb_draw_text'],
              priority: 10,
            },
          ],
        },
      }),
    );
    const events = await readSseEvents(response);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ data: { totalActions: 1 } });
    const feedback = JSON.stringify(childPayloads.at(-1));
    expect(feedback).toContain('Whiteboard state changed.');
    expect(feedback).toContain('Call wb_read');
    const provider = await mocks.getServerPersistenceProvider.mock.results[0]?.value;
    const sessions = await provider.runtimeStore.listSessions('stage-1', LEARNER_KEY);
    const records = await provider.runtimeStore.listRecords(sessions[0].id);
    expect(records).toHaveLength(1);
  }, 15000);

  it.each([
    { vision: true, configured: true, healthy: true },
    { vision: true, configured: true, healthy: false },
    { vision: false, configured: true, healthy: true },
    { vision: undefined, configured: true, healthy: true },
    { vision: true, configured: false, healthy: true },
  ])(
    'sends only the latest tail PNG through the provider adapter ($vision/$configured/$healthy)',
    async ({ vision, configured, healthy }) => {
      // The health probe runs only when an image could otherwise be sent.
      const probed = vision === true && configured;
      const imagesEnabled = probed && healthy;
      process.env.DATABASE_URL = 'postgres://shared-provider-test';
      if (configured) process.env.RENDER_SERVICE_URL = 'http://render.test';
      const { createWhiteboardRuntimeService } = await import('@/lib/whiteboard/runtime/store');
      const { buildNativeWhiteboardTools } = await import('@/lib/chat/pi/tools/native-whiteboard');
      const provider = await mocks.getServerPersistenceProvider();
      const service = createWhiteboardRuntimeService({
        store: provider.runtimeStore,
        resolveLearnerKey: () => LEARNER_KEY,
        withMaintenanceLock: (work) => work(),
      });
      const tools = buildNativeWhiteboardTools({
        agent: { allowedActions: ['wb_draw_text'] } as never,
        messageId: 'seed',
        send: async () => {},
        service,
        stageId: 'stage-1',
        learnerKey: LEARNER_KEY,
        requestStartManualVisibilityRevision: 0,
      });
      await tools
        .find((t) => t.name === 'wb_draw_text')!
        .execute('seed', { expectedLastSeq: null, content: 'Existing label', x: 20, y: 20 });
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
      const snapshots: Array<{ elements: Array<{ content: string }> }> = [];
      const healthProbes: string[] = [];
      mocks.previewFetch.mockImplementation(async (url, init) => {
        if (String(url).endsWith('/health')) {
          healthProbes.push(String(url));
          return healthy
            ? Response.json({}, { headers: { 'x-openmaic-render-owner-bound': '1' } })
            : new Response(null, { status: 503 });
        }
        snapshots.push(JSON.parse(init.body).scene.content.canvas);
        return new Response(
          Buffer.concat([Buffer.from(png, 'base64'), Buffer.from(String(snapshots.length))]),
          {
            headers: { 'Content-Type': 'image/png' },
          },
        );
      });
      const childWire: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
      const directorWire: typeof childWire = [];
      const director = [
        {
          name: 'call_agent',
          arguments: { agentId: 'teacher-1', instruction: 'Add two concise labels.' },
        },
        {
          name: 'call_agent',
          arguments: { agentId: 'teacher-1', instruction: 'Check the existing board.' },
        },
        { name: 'cue_user', arguments: { prompt: 'Continue?' } },
      ];
      const child = [
        {
          name: 'wb_draw_text',
          arguments: { expectedLastSeq: 0, content: 'First > label', x: 80, y: 100 },
        },
        {
          name: 'wb_draw_text',
          arguments: { expectedLastSeq: 1, content: 'Second label', x: 80, y: 180 },
        },
      ];
      const model = createOpenAI({
        apiKey: 'offline-test',
        fetch: async (_url, init) => {
          const wire = JSON.parse(String(init?.body));
          const isChild = wire.tools.some(
            (tool: { function: { name: string } }) => tool.function.name === 'wb_draw_text',
          );
          (isChild ? childWire : directorWire).push(wire);
          const call = (isChild ? child : director).shift();
          const chunk = (delta: unknown, finishReason: string | null) => ({
            id: 'offline',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          });
          const chunks = call
            ? [
                chunk(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call-${isChild ? 'child' : 'director'}-${isChild ? childWire.length : directorWire.length}`,
                        type: 'function',
                        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                      },
                    ],
                  },
                  null,
                ),
                chunk({}, 'tool_calls'),
              ]
            : [chunk({ content: 'Done.' }, null), chunk({}, 'stop')];
          return new Response(
            chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        },
      }).chat('test');
      mocks.resolveModel.mockResolvedValue({
        model,
        apiKey: 'offline-test',
        providerId: 'openai',
        modelInfo: { outputWindow: 512, contextWindow: 16000, capabilities: { vision } },
        thinkingConfig: { mode: 'disabled', enabled: false },
      });
      mocks.streamLLM.mockImplementation((options) => streamText({ ...options, maxRetries: 0 }));
      const { POST } = await import('@/app/api/chat/pi/route');
      const response = await POST(
        makeRequest({
          config: {
            agentIds: ['teacher-1'],
            piEnableWhiteboardTools: true,
            agentConfigs: [
              {
                id: 'teacher-1',
                name: 'Teacher',
                role: 'teacher',
                persona: 'Explain.',
                avatar: '',
                color: '#3366ff',
                allowedActions: ['wb_draw_text'],
                priority: 10,
              },
            ],
          },
        }),
      );
      const events = await readSseEvents(response);
      expect(events.find((event) => event.type === 'done')).toMatchObject({
        data: { totalActions: 2 },
      });
      expect(snapshots.map((s) => s.elements.length)).toEqual(imagesEnabled ? [1, 2, 3] : []);
      if (imagesEnabled) expect(snapshots[1].elements[1].content).toContain('First &gt; label');
      expect(childWire).toHaveLength(4);
      const imageParts = (wire: (typeof childWire)[number]) =>
        wire.messages
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .filter((part) => part.type === 'image_url');
      expect(childWire.map((wire) => imageParts(wire).length)).toEqual(
        imagesEnabled ? [1, 1, 1, 1] : [0, 0, 0, 0],
      );
      expect(directorWire.map((wire) => imageParts(wire).length)).toEqual(
        imagesEnabled ? [1, 1, 1] : [0, 0, 0],
      );
      for (const wire of [...childWire, ...directorWire]) {
        const tail = wire.messages.at(-1)!;
        expect(JSON.stringify(tail)).toContain('state data');
        expect(
          wire.messages
            .slice(0, -1)
            .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
            .filter((part) => part.type === 'image_url'),
        ).toHaveLength(0);
        expect(JSON.stringify(wire.messages.filter((m) => m.role === 'tool'))).not.toContain(
          'image_url',
        );
      }
      if (imagesEnabled) {
        const imageFor = (number: number) =>
          'data:image/png;base64,' +
          Buffer.concat([Buffer.from(png, 'base64'), Buffer.from(String(number))]).toString(
            'base64',
          );
        expect(childWire.map((wire) => imageParts(wire)[0].image_url.url)).toEqual([
          imageFor(1),
          imageFor(2),
          imageFor(3),
          imageFor(3),
        ]);
        expect(directorWire.map((wire) => imageParts(wire)[0].image_url.url)).toEqual([
          imageFor(1),
          imageFor(3),
          imageFor(3),
        ]);
      }
      expect(JSON.stringify(childWire[2].messages.at(-1))).toContain('lastSeq');
      // No writes in the second Child: it and both later Director rounds reuse the same render.
      expect(healthProbes).toEqual(probed ? ['http://render.test/health'] : []);
      expect(mocks.previewFetch).toHaveBeenCalledTimes((probed ? 1 : 0) + (imagesEnabled ? 3 : 0));
    },
    15000,
  );

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

  it('wires RuntimeStore WB inventory through the real route and completes an action-only Child', async () => {
    process.env.DATABASE_URL = 'postgres://shared-provider-test';
    const directorResponses = [
      [toolCall('read-1', 'read_scene', { sceneId: 'scene-current' }), finish('tool-calls')],
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Read the whiteboard, then add one concise label.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Continue?' }), finish('tool-calls')],
    ];
    const childResponses = [
      [toolCall('wb-read-1', 'wb_read', {}), finish('tool-calls')],
      [
        toolCall('wb-draw-1', 'wb_draw_text', {
          expectedLastSeq: null,
          content: 'Runtime authority',
          x: 80,
          y: 100,
        }),
        finish('tool-calls'),
      ],
      [finish('stop')],
    ];
    const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
    mocks.streamLLM.mockImplementation((options, source) => {
      payloads.push({ source, options });
      const parts =
        source === 'pi-chat-native-child' ? childResponses.shift() : directorResponses.shift();
      return resultFrom(parts ?? [finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        config: {
          agentIds: ['teacher-1'],
          piEnableWhiteboardTools: true,
          agentConfigs: [
            {
              id: 'teacher-1',
              name: 'Teacher',
              role: 'teacher',
              persona: 'Use the whiteboard directly.',
              avatar: '',
              color: '#3366ff',
              allowedActions: ['wb_draw_text', 'wb_delete', 'wb_clear', 'wb_edit_code'],
              priority: 10,
            },
          ],
        },
      }),
    );
    const events = await readSseEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.getServerPersistenceProvider).toHaveBeenCalledWith(
      'postgres://shared-provider-test',
    );
    const childPayloads = payloads.filter((payload) => payload.source === 'pi-chat-native-child');
    expect(childPayloads).toHaveLength(3);
    expect(childPayloads[0]?.options.tools).toHaveProperty('wb_read');
    expect(childPayloads[0]?.options.tools).toHaveProperty('wb_open');
    expect(childPayloads[0]?.options.tools).toHaveProperty('wb_draw_text');
    expect(childPayloads[0]?.options.tools).toHaveProperty('wb_delete');
    expect(childPayloads[0]?.options.tools).toHaveProperty('wb_clear');
    expect(childPayloads[0]?.options.tools).toHaveProperty('wb_edit_code');
    expect(childPayloads[0]?.options.tools).toHaveProperty('wb_close');
    const providerTools = childPayloads[0]?.options.tools as
      | Record<
          string,
          {
            inputSchema?: {
              jsonSchema?: {
                type?: string;
                anyOf?: unknown[];
                required?: string[];
                properties?: {
                  expectedLastSeq?: {
                    type?: string[];
                    minimum?: number;
                    description?: string;
                  };
                };
              };
            };
          }
        >
      | undefined;
    for (const [toolName, tool] of Object.entries(providerTools ?? {})) {
      expect(tool.inputSchema?.jsonSchema?.type, toolName).toBe('object');
    }
    const providerDrawTool = providerTools?.wb_draw_text;
    const providerEditTool = providerTools?.wb_edit_code;
    expect(providerEditTool?.inputSchema?.jsonSchema?.anyOf).toHaveLength(4);
    expect(providerDrawTool?.inputSchema?.jsonSchema?.required).toContain('expectedLastSeq');
    expect(
      providerDrawTool?.inputSchema?.jsonSchema?.properties?.expectedLastSeq?.description,
    ).toContain('Copy nextMutation.expectedLastSeq exactly');
    expect(providerDrawTool?.inputSchema?.jsonSchema?.properties?.expectedLastSeq).toMatchObject({
      type: ['integer', 'null'],
      minimum: 0,
    });
    expect(JSON.stringify(childPayloads[1]?.options.messages)).toContain(
      'nextMutation\\\":{\\\"expectedLastSeq\\\":null',
    );
    expect(JSON.stringify(childPayloads[2]?.options.messages)).toContain('committedSeq');

    expect(events).toContainEqual({
      type: 'whiteboard',
      data: expect.objectContaining({
        kind: 'visibility_query',
        stageId: 'stage-1',
      }),
    });
    expect(events).toContainEqual({
      type: 'whiteboard',
      data: { kind: 'projection', stageId: 'stage-1', lastSeq: 0 },
    });
    expect(
      events.some((event) => event.type === 'action' && event.data?.actionName === 'wb_draw_text'),
    ).toBe(false);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      data: { totalAgents: 1, totalActions: 1, agentHadContent: true },
    });

    const provider = await mocks.getServerPersistenceProvider.mock.results[0]?.value;
    const sessions = await provider.runtimeStore.listSessions('stage-1', LEARNER_KEY);
    expect(sessions).toHaveLength(1);
    const records: RuntimeRecord[] = await provider.runtimeStore.listRecords(sessions[0]!.id);
    expect(records).toHaveLength(1);
    expect(records[0]?.seq).toBe(0);
  }, 15_000);

  it('writes no whiteboard runtime for a deleted course', async () => {
    process.env.DATABASE_URL = 'postgres://shared-provider-test';
    mocks.stageMetaQuery.mockResolvedValue({
      rows: [
        {
          stage_id: 'stage-1',
          owner_id: LEARNER_KEY,
          is_public: false,
          published_at: null,
          generation_complete: true,
          deleted_at: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    const directorResponses = [
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Add one concise label to the whiteboard.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Continue?' }), finish('tool-calls')],
    ];
    const childResponses = [
      [
        toolCall('wb-draw-1', 'wb_draw_text', {
          expectedLastSeq: null,
          content: 'Should not persist',
          x: 80,
          y: 100,
        }),
        finish('tool-calls'),
      ],
      [finish('stop')],
    ];
    mocks.streamLLM.mockImplementation((_options, source) => {
      const parts =
        source === 'pi-chat-native-child' ? childResponses.shift() : directorResponses.shift();
      return resultFrom(parts ?? [finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        config: {
          agentIds: ['teacher-1'],
          piEnableWhiteboardTools: true,
          agentConfigs: [
            {
              id: 'teacher-1',
              name: 'Teacher',
              role: 'teacher',
              persona: 'Use the whiteboard directly.',
              avatar: '',
              color: '#3366ff',
              allowedActions: ['wb_draw_text'],
              priority: 10,
            },
          ],
        },
      }),
    );
    await readSseEvents(response);

    expect(response.status).toBe(200);
    expect(mocks.stageMetaQuery).toHaveBeenCalled();
    const provider = await mocks.getServerPersistenceProvider.mock.results[0]?.value;
    await expect(provider.runtimeStore.listSessions('stage-1', LEARNER_KEY)).resolves.toEqual([]);
  }, 15_000);

  it('executes wb_draw_text → wb_delete through the production route in one Child', async () => {
    process.env.DATABASE_URL = 'postgres://shared-provider-test';
    const directorResponses = [
      [toolCall('read-1', 'read_scene', { sceneId: 'scene-current' }), finish('tool-calls')],
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Draw one temporary label, then delete that exact label.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Continue?' }), finish('tool-calls')],
    ];
    const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
    let childTransport = 0;
    mocks.streamLLM.mockImplementation((options, source) => {
      payloads.push({ source, options });
      if (source !== 'pi-chat-native-child') {
        return resultFrom(directorResponses.shift() ?? [finish('stop')]);
      }
      childTransport += 1;
      if (childTransport === 1) {
        return resultFrom([toolCall('wb-read-1', 'wb_read', {}), finish('tool-calls')]);
      }
      if (childTransport === 2) {
        return resultFrom([
          toolCall('wb-draw-1', 'wb_draw_text', {
            expectedLastSeq: null,
            content: 'Temporary Runtime label',
            x: 80,
            y: 100,
          }),
          finish('tool-calls'),
        ]);
      }
      if (childTransport === 3) {
        const elementId = JSON.stringify(options.messages).match(
          /native-wb-element:[0-9a-f]{64}/u,
        )?.[0];
        expect(elementId).toBeDefined();
        return resultFrom([
          toolCall('wb-delete-1', 'wb_delete', {
            expectedLastSeq: 0,
            elementId,
          }),
          finish('tool-calls'),
        ]);
      }
      return resultFrom([finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        config: {
          agentIds: ['teacher-1'],
          piEnableWhiteboardTools: true,
          agentConfigs: [
            {
              id: 'teacher-1',
              name: 'Teacher',
              role: 'teacher',
              persona: 'Use the whiteboard directly.',
              avatar: '',
              color: '#3366ff',
              allowedActions: ['wb_draw_text', 'wb_delete'],
              priority: 10,
            },
          ],
        },
      }),
    );
    const events = await readSseEvents(response);

    expect(response.status).toBe(200);
    const childPayloads = payloads.filter((payload) => payload.source === 'pi-chat-native-child');
    expect(childPayloads).toHaveLength(4);
    expect(JSON.stringify(childPayloads[2]?.options.messages)).toContain('wb-draw-1');
    expect(JSON.stringify(childPayloads[2]?.options.messages)).toContain('committedSeq');
    expect(JSON.stringify(childPayloads[3]?.options.messages)).toContain('wb-delete-1');
    expect(JSON.stringify(childPayloads[3]?.options.messages)).toContain('elementId');

    expect(
      events.filter((event) => event.type === 'whiteboard' && event.data?.kind === 'projection'),
    ).toEqual([
      {
        type: 'whiteboard',
        data: { kind: 'projection', stageId: 'stage-1', lastSeq: 0 },
      },
      {
        type: 'whiteboard',
        data: { kind: 'projection', stageId: 'stage-1', lastSeq: 1 },
      },
    ]);
    expect(events.filter((event) => event.type === 'action')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      data: { totalAgents: 1, totalActions: 2, agentHadContent: true },
    });

    const provider = await mocks.getServerPersistenceProvider.mock.results[0]?.value;
    const sessions = await provider.runtimeStore.listSessions('stage-1', LEARNER_KEY);
    expect(sessions).toHaveLength(1);
    const records: RuntimeRecord[] = await provider.runtimeStore.listRecords(sessions[0]!.id);
    expect(records.map((record) => record.seq)).toEqual([0, 1]);
    expect(
      records.map(
        (record) => (record.payload as { operation?: { kind?: string } }).operation?.kind,
      ),
    ).toEqual(['element_added', 'element_deleted']);
  }, 15_000);

  it('completes a 12-provider-request whiteboard Child with reads and a corrective call without a turn deadline or transport cap', async () => {
    process.env.DATABASE_URL = 'postgres://shared-provider-test';
    const directorResponses = [
      [toolCall('read-1', 'read_scene', { sceneId: 'scene-current' }), finish('tool-calls')],
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Build the whiteboard in four steps, checking it as you go.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Continue?' }), finish('tool-calls')],
    ];
    const childResponses = [
      [toolCall('wb-read-1', 'wb_read', {}), finish('tool-calls')],
      [
        toolCall('wb-draw-1', 'wb_draw_text', {
          expectedLastSeq: null,
          content: 'Step one',
          x: 80,
          y: 100,
        }),
        finish('tool-calls'),
      ],
      [toolCall('wb-read-2', 'wb_read', {}), finish('tool-calls')],
      [
        toolCall('wb-draw-invalid', 'wb_draw_text', {
          content: 'Missing the required sequence',
          x: 80,
          y: 160,
        }),
        finish('tool-calls'),
      ],
      [toolCall('wb-read-3', 'wb_read', {}), finish('tool-calls')],
      [
        toolCall('wb-draw-2', 'wb_draw_text', {
          expectedLastSeq: 0,
          content: 'Step two',
          x: 80,
          y: 160,
        }),
        finish('tool-calls'),
      ],
      [toolCall('wb-read-4', 'wb_read', {}), finish('tool-calls')],
      [
        toolCall('wb-draw-3', 'wb_draw_text', {
          expectedLastSeq: 1,
          content: 'Step three',
          x: 80,
          y: 220,
        }),
        finish('tool-calls'),
      ],
      [toolCall('wb-read-5', 'wb_read', {}), finish('tool-calls')],
      [
        toolCall('wb-draw-4', 'wb_draw_text', {
          expectedLastSeq: 2,
          content: 'Step four',
          x: 80,
          y: 280,
        }),
        finish('tool-calls'),
      ],
      [toolCall('wb-read-6', 'wb_read', {}), finish('tool-calls')],
      [
        {
          type: 'text-delta',
          text: 'The board is complete after the corrective step.',
        },
        finish('stop'),
      ],
    ];
    const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
    mocks.streamLLM.mockImplementation((options, source) => {
      payloads.push({ source, options });
      const parts =
        source === 'pi-chat-native-child' ? childResponses.shift() : directorResponses.shift();
      return resultFrom(parts ?? [finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        config: {
          agentIds: ['teacher-1'],
          piEnableWhiteboardTools: true,
          agentConfigs: [
            {
              id: 'teacher-1',
              name: 'Teacher',
              role: 'teacher',
              persona: 'Use the whiteboard directly.',
              avatar: '',
              color: '#3366ff',
              allowedActions: ['wb_draw_text'],
              priority: 10,
            },
          ],
        },
      }),
    );
    const events = await readSseEvents(response);

    expect(response.status).toBe(200);
    const childPayloads = payloads.filter((payload) => payload.source === 'pi-chat-native-child');
    expect(childPayloads).toHaveLength(12);
    expect(JSON.stringify(childPayloads[4]?.options.messages)).toContain('wb-draw-invalid');
    expect(events.filter((event) => event.type === 'agent_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          content: 'The board is complete after the corrective step.',
        }),
      }),
    ]);
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      data: { totalAgents: 1, totalActions: 4, agentHadContent: true },
    });

    const provider = await mocks.getServerPersistenceProvider.mock.results[0]?.value;
    const sessions = await provider.runtimeStore.listSessions('stage-1', LEARNER_KEY);
    expect(sessions).toHaveLength(1);
    const records: RuntimeRecord[] = await provider.runtimeStore.listRecords(sessions[0]!.id);
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2, 3]);
  }, 15_000);

  it.each([
    {
      name: 'an invalid request-start Stage ID',
      request: () =>
        makeRequest({
          storeState: {
            stage: { id: '   ', name: 'Invalid Stage', createdAt: 1, updatedAt: 2 },
            outlines: [],
            scenes: [
              {
                id: 'scene-current',
                stageId: '   ',
                title: 'Current slide',
                order: 1,
                type: 'slide',
                content: { type: 'slide', canvas: { elements: [] } },
              },
            ],
            currentSceneId: 'scene-current',
            mode: 'autonomous',
            whiteboardOpen: false,
          },
          config: {
            agentIds: ['teacher-1'],
            piEnableWhiteboardTools: true,
            agentConfigs: [
              {
                id: 'teacher-1',
                name: 'Teacher',
                role: 'teacher',
                persona: 'Teach directly.',
                avatar: '',
                color: '#3366ff',
                allowedActions: ['wb_draw_text'],
                priority: 10,
              },
            ],
          },
        }),
    },
  ])('keeps the Native WB bundle absent for $name', async ({ request }) => {
    process.env.DATABASE_URL = 'postgres://shared-provider-test';
    const directorResponses = [
      [toolCall('read-1', 'read_scene', { sceneId: 'scene-current' }), finish('tool-calls')],
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Give one short explanation.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Continue?' }), finish('tool-calls')],
    ];
    const childResponses = [
      [{ type: 'text-delta', text: 'No whiteboard capability.' }, finish('stop')],
    ];
    const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
    mocks.streamLLM.mockImplementation((options, source) => {
      payloads.push({ source, options });
      const parts =
        source === 'pi-chat-native-child' ? childResponses.shift() : directorResponses.shift();
      return resultFrom(parts ?? [finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(request());
    expect(response.status).toBe(200);
    await response.text();

    expect(mocks.getServerPersistenceProvider).not.toHaveBeenCalled();
    const child = payloads.find((payload) => payload.source === 'pi-chat-native-child');
    expect(child?.options.tools).not.toHaveProperty('wb_read');
    expect(child?.options.tools).not.toHaveProperty('wb_draw_text');
  });

  it('refuses a rejected owner credential with 401 before any model work', async () => {
    process.env.DATABASE_URL = 'postgres://shared-provider-test';
    rejectOwnerCredentials();
    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest(
        {
          config: {
            agentIds: ['teacher-1'],
            piEnableWhiteboardTools: true,
            agentConfigs: [
              {
                id: 'teacher-1',
                name: 'Teacher',
                role: 'teacher',
                persona: 'Teach directly.',
                avatar: '',
                color: '#3366ff',
                allowedActions: ['wb_draw_text'],
                priority: 10,
              },
            ],
          },
        },
        { cookie: `anonymous_id=${OWNER_COOKIE}` },
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_CREDENTIAL' } });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.streamLLM).not.toHaveBeenCalled();
    expect(mocks.getServerPersistenceProvider).not.toHaveBeenCalled();
  });

  it('keeps Pi chat available without WB inventory when persistence initialization fails', async () => {
    process.env.DATABASE_URL = 'postgres://unavailable-provider-test';
    mocks.getServerPersistenceProvider.mockRejectedValue(new Error('pool unavailable'));
    const directorResponses = [
      [toolCall('read-1', 'read_scene', { sceneId: 'scene-current' }), finish('tool-calls')],
      [
        toolCall('delegate-1', 'call_agent', {
          agentId: 'teacher-1',
          instruction: 'Give one short explanation.',
        }),
        finish('tool-calls'),
      ],
      [toolCall('cue-1', 'cue_user', { prompt: 'Continue?' }), finish('tool-calls')],
    ];
    const childResponses = [
      [{ type: 'text-delta', text: 'Whiteboard is unavailable.' }, finish('stop')],
    ];
    const payloads: Array<{ source: string; options: Record<string, unknown> }> = [];
    mocks.streamLLM.mockImplementation((options, source) => {
      payloads.push({ source, options });
      const parts =
        source === 'pi-chat-native-child' ? childResponses.shift() : directorResponses.shift();
      return resultFrom(parts ?? [finish('stop')]);
    });

    const { POST } = await import('@/app/api/chat/pi/route');
    const response = await POST(
      makeRequest({
        config: {
          agentIds: ['teacher-1'],
          piEnableWhiteboardTools: true,
          agentConfigs: [
            {
              id: 'teacher-1',
              name: 'Teacher',
              role: 'teacher',
              persona: 'Teach directly.',
              avatar: '',
              color: '#3366ff',
              allowedActions: ['wb_draw_shape'],
              priority: 10,
            },
          ],
        },
      }),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getServerPersistenceProvider).toHaveBeenCalledOnce();
    const child = payloads.find((payload) => payload.source === 'pi-chat-native-child');
    expect(child?.options.tools).not.toHaveProperty('wb_read');
    expect(child?.options.tools).not.toHaveProperty('wb_draw_shape');
  });

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
