import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  streamLLM: vi.fn(),
}));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
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
  'OPENMAIC_ENABLE_PI_WEB_SEARCH',
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

function makeRequest(): NextRequest {
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
    delete process.env.OPENMAIC_ENABLE_PI_WEB_SEARCH;
    mocks.resolveModel.mockReset();
    mocks.streamLLM.mockReset();
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
    expect(childPayloads[0]?.options.tools).not.toHaveProperty('web_search');
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

  it('keeps the production route on the Legacy Child harness when both new flags are absent', async () => {
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
  });
});
