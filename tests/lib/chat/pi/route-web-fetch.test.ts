import * as dns from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  setDeploymentConfigForTests,
  setWorkspaceLayerLoaderForTests,
} from '@/lib/server/model-config/runtime';
import * as webFetchConfig from '@/lib/server/web-fetch-config';
import { kimi } from '@/lib/web-fetch/providers/kimi';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn(), searchWeb: vi.fn(), resolveModel: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/web-search', async (original) => ({
  ...(await original<typeof import('@/lib/web-search')>()),
  searchWeb: mocks.searchWeb,
}));
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const URL = 'https://example.com/classroom-evidence';
const FACT = 'The experimental group repeats each measurement three times and takes the mean';
const PAGE = `${FACT}. ${'This is background for the article. '.repeat(75)}End of article.`;
const usage = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};
let childResponses: Array<Array<Record<string, unknown>>>;
let directorResponses: Array<Array<Record<string, unknown>>>;
let transportRecords: Array<{
  source: string;
  tools: string[];
  toolResults: string[];
  system: string;
  calls: unknown[];
}>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function finish(reason = 'stop') {
  return { type: 'finish', finishReason: reason, totalUsage: usage };
}
function call(name: string, input: Record<string, unknown>, id = name) {
  return { type: 'tool-call', toolName: name, toolCallId: id, input };
}
function speech(text: string) {
  return [{ type: 'text-delta', text }, finish()];
}
function toolTurn(...calls: ReturnType<typeof call>[]) {
  return [...calls, finish('tool-calls')];
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_PI_CHAT_ENABLED', 'true');
  vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'true');
  vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_SPOTLIGHT', 'false');
  vi.stubEnv('DATABASE_URL', '');
  mocks.streamLLM.mockReset();
  mocks.searchWeb.mockReset();
  mocks.resolveModel.mockResolvedValue({
    model: { provider: 'fixture', modelId: 'fixture' },
    apiKey: 'fixture-key',
    providerId: 'openai',
    modelInfo: { outputWindow: 1024, contextWindow: 16000 },
    thinkingConfig: { mode: 'disabled', enabled: false },
  });
  vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  fetchSpy = vi
    .spyOn(kimi, 'extract')
    .mockResolvedValue({ title: 'Classroom experiment guide', markdown: PAGE, finalUrl: URL });
  mocks.searchWeb.mockResolvedValue({
    query: 'classroom experiment procedure',
    answer: 'The article discusses a classroom experiment.',
    responseTime: 0.1,
    sources: [
      {
        url: URL,
        title: 'Classroom experiment guide',
        content: 'The article introduces a classroom experiment and its background.',
        score: 1,
      },
    ],
  });
  directorResponses = [
    toolTurn(
      call('call_agent', {
        agentId: 'teacher',
        instruction: 'Answer the learner from the available evidence.',
      }),
    ),
    toolTurn(call('cue_user', { prompt: 'Anything else to explain?' })),
  ];
  childResponses = [];
  transportRecords = [];
  mocks.streamLLM.mockImplementation((options, source) => {
    const toolResults = (options.messages ?? [])
      .filter((message: { role: string }) => message.role === 'tool')
      .flatMap((message: { content: Array<{ output?: { value?: unknown } }> }) =>
        message.content.map((part) => String(part.output?.value ?? '')),
      );
    const parts = (source === 'pi-chat-director' ? directorResponses : childResponses).shift();
    if (!parts) throw new Error(`Unexpected fixture transport ${source}`);
    transportRecords.push({
      source,
      tools: Object.keys(options.tools ?? {}),
      toolResults,
      system: options.system ?? '',
      calls: parts
        .filter((part) => part.type === 'tool-call')
        .map(({ toolName, input }) => ({ toolName, input })),
    });
    return {
      fullStream: (async function* () {
        for (const part of parts) yield part;
      })(),
      usage: new Promise(() => {}),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setDeploymentConfigForTests();
  setWorkspaceLayerLoaderForTests();
});

async function run(userText: string, options: { webFetchSlot?: string | null } = {}) {
  setDeploymentConfigForTests({
    legacy: false,
    notices: [],
    layer: {
      source: 'deployment',
      config: {
        providers: { reader: { preset: 'kimi', apiKey: 'fixture-key' } },
        slots: { webFetch: options.webFetchSlot === undefined ? 'reader' : options.webFetchSlot },
      },
    },
  });
  setWorkspaceLayerLoaderForTests(async () => null);
  const { POST } = await import('@/app/api/chat/pi/route');
  const request = new Request('http://localhost/api/chat/pi', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: 'anonymous_id=88888888-8888-4888-8888-888888888888',
    },
    body: JSON.stringify({
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: userText }] }],
      storeState: {
        stage: { id: 'web-stage', name: 'Web reading classroom', createdAt: 1, updatedAt: 1 },
        scenes: [],
        currentSceneId: null,
        mode: 'autonomous',
        whiteboardOpen: false,
      },
      config: {
        agentIds: ['teacher'],
        agentConfigs: [
          {
            id: 'teacher',
            name: 'Teacher',
            role: 'teacher',
            persona: 'Helps learners with accurate, brief explanations.',
            avatar: '👩‍🏫',
            color: '#4052c7',
            allowedActions: [],
            priority: 10,
          },
        ],
      },
      apiKey: '',
      model: 'fixture',
      webSearchProviderId: 'tavily',
      webSearchApiKey: 'fixture-search-key',
    }),
  });
  const response = await POST(request as NextRequest);
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  const events = raw
    .split('\n\n')
    .filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice(6)));
  expect(
    events.find((event) => event.type === 'done'),
    raw,
  ).toBeDefined();
  expect(events.some((event) => event.type === 'error')).toBe(false);
  return {
    events,
    children: transportRecords.filter((transport) => transport.source === 'pi-chat-native-child'),
  };
}

describe('POST /api/chat/pi classroom fetch_url (#1925)', () => {
  it('reads a link the learner pasted', async () => {
    childResponses = [
      toolTurn(call('fetch_url', { url: URL })),
      speech(`The page says: ${FACT}. This reduces random error.`),
    ];
    const { children, events } = await run(`Please read ${URL} — what is the procedure?`);
    expect(children[1].toolResults.join('\n')).toContain(FACT);
    const messageId = events.find((event) => event.type === 'agent_start').data.messageId;
    expect(events.filter((event) => event.type === 'action').map((event) => event.data)).toEqual([
      { actionName: 'fetch_url', actionId: 'fetch_url', messageId, agentId: 'teacher', params: {} },
    ]);
    expect(children[1].toolResults.join('\n')).toContain('Only the first part');
    expect(children[1].toolResults.join('\n')).not.toContain('End of article.');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mocks.searchWeb).not.toHaveBeenCalled();
    const director = transportRecords.find((transport) => transport.source === 'pi-chat-director');
    expect(director?.tools).not.toContain('fetch_url');
    expect(director?.system).toContain('Child web_search: configured and available.');
    expect(director?.system).toContain('Child fetch_url: available.');
  }, 15_000);

  it('reads a page that web_search returned', async () => {
    childResponses = [
      toolTurn(call('web_search', { query: 'classroom experiment procedure' })),
      toolTurn(call('fetch_url', { url: URL })),
      speech(`The excerpt has no procedure; the page says ${FACT}.`),
    ];
    const { children, events } = await run(
      'Find the classroom experiment guide and tell me the measurement steps.',
    );
    expect(children[1].toolResults.join('\n')).not.toContain(FACT);
    expect(children[2].toolResults.join('\n')).toContain(FACT);
    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['web_search', 'fetch_url']);
    expect(mocks.searchWeb).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('leaves an ordinary question offline', async () => {
    childResponses = [speech('Averaging reduces random error but not systematic error.')];
    await run('Why do experiments take the mean?');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  }, 15_000);

  it('drops fetch_url and its prompt sections when webFetch is null', async () => {
    childResponses = [
      toolTurn(call('web_search', { query: 'classroom experiment procedure' })),
      speech('I can only see search excerpts here; please paste the page text.'),
    ];
    const { children, events } = await run(`Please read ${URL}.`, { webFetchSlot: null });
    expect(mocks.searchWeb).toHaveBeenCalledOnce();
    expect(children[0].tools).toContain('web_search');
    expect(children[0].tools).not.toContain('fetch_url');
    expect(children[0].system).not.toContain('# Reading web evidence');
    const director = transportRecords.find((transport) => transport.source === 'pi-chat-director');
    expect(director?.system).not.toContain('fetch_url');
    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['web_search']);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 15_000);

  it('keeps the classroom working without fetch_url when the webFetch slot cannot resolve', async () => {
    childResponses = [speech('Please paste the text.')];
    const { children } = await run(`Please read ${URL}.`, { webFetchSlot: 'missing-reader' });
    expect(children[0].tools).not.toContain('fetch_url');
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 15_000);

  it('blocks a private-network link before any provider call', async () => {
    childResponses = [
      toolTurn(call('fetch_url', { url: 'http://127.0.0.1/private' })),
      speech('That link cannot be read safely; please share a public page or paste the text.'),
    ];
    const { children, events } = await run('Please read http://127.0.0.1/private.');
    expect(children[1].toolResults.join('\n')).toContain('The page could not be read');
    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionName),
    ).toEqual(['fetch_url']);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 15_000);

  it('can retry an unobserved public URL and read another page in the same request', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Temporary reader failure'));
    childResponses = [
      toolTurn(call('fetch_url', { url: URL }, 'f1')),
      toolTurn(call('fetch_url', { url: URL }, 'f2')),
      toolTurn(call('fetch_url', { url: 'https://example.org/another' }, 'f3')),
      speech('The guide describes repeated measurements.'),
    ];
    const { children, events } = await run('Check the measurement procedure in two guides.');
    expect(mocks.searchWeb).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(children[1].toolResults.join('\n')).toContain('Its contents are unverified');
    expect(children[1].toolResults.join('\n')).not.toContain('Temporary reader failure');
    expect(children[2].toolResults.join('\n')).toContain(FACT);
    expect(
      events.filter((event) => event.type === 'action').map((event) => event.data.actionId),
    ).toEqual(['f1', 'f2', 'f3']);
  }, 15_000);

  it('skips webFetch resolution and registration for Legacy Children', async () => {
    vi.stubEnv('OPENMAIC_ENABLE_PI_NATIVE_CHILD_RUNTIME', 'false');
    const resolveFetch = vi.spyOn(webFetchConfig, 'resolveWebFetchCapability');
    childResponses = [speech('[{"type":"text","content":"Legacy response."}]')];
    const { events } = await run('Explain the measurement procedure.');
    expect(resolveFetch).not.toHaveBeenCalled();
    const legacy = transportRecords.find((record) => record.source === 'pi-chat-child');
    expect(legacy).toBeDefined();
    expect(legacy!.tools).not.toContain('fetch_url');
    expect(legacy!.system).not.toContain('# Reading web evidence');
    expect(events.filter((event) => event.type === 'action')).toHaveLength(0);
  }, 15_000);
});
