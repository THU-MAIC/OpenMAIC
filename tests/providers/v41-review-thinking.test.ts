import { jsonSchema, type LanguageModel } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModel } from '@/lib/ai/providers';
import { callLLM } from '@/lib/ai/llm';
import {
  getClassroomContentOutputOptions,
  getClassroomContentThinkingConfig,
} from '@/lib/server/classroom-content-transport';

vi.mock('@/lib/server/usage-storage', () => ({
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const flash = 'deepseek-ai/DeepSeek-V4-Flash';
const v41 = 'deepseek-ai/DeepSeek-V4.1-Flash';
const high = {
  mode: 'enabled' as const,
  enabled: true,
  effort: 'high' as const,
  budgetTokens: 2048,
};
const disabled = { mode: 'disabled' as const, enabled: false };
const schema = jsonSchema<{ fixture: boolean }>({
  type: 'object',
  additionalProperties: false,
  required: ['fixture'],
  properties: { fixture: { type: 'boolean' } },
});
const makeModel = (baseUrl: string, modelId = v41) =>
  getModel({
    providerId: 'openai',
    modelId,
    baseUrl,
    apiKey: 'offline-v7-fixture-only',
  }).model;

function intercept() {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(init?.method).toBe('POST');
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    const response = {
      id: 'offline-v7-wire',
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          delta: { content: '{"fixture":true}' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
    };
    return new Response('data: ' + JSON.stringify(response) + '\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, fetch };
}

function params(model: LanguageModel) {
  return {
    model,
    messages: [
      {
        role: 'system' as const,
        content: 'Offline transport contract; no semantic acceptance.',
      },
      { role: 'user' as const, content: 'Return the bound fixture exactly.' },
    ],
    ...getClassroomContentOutputOptions(model, schema),
    maxRetries: 0,
    abortSignal: new AbortController().signal,
  };
}

describe('V7 V4.1 review/limited-repair explicit thinking transport', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
    vi.stubEnv('LLM_THINKING_DISABLED', 'false');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const base of ['https://api.siliconflow.cn/v1', 'https://api.siliconflow.com/v1']) {
    it(
      'captures the actual structured SDK request with only enable_thinking=true added: ' + base,
      async () => {
        const { requests, fetch } = intercept();
        const model = makeModel(base);
        const selected = getClassroomContentThinkingConfig(model, high);
        expect(selected).toEqual({
          mode: 'enabled',
          enabled: true,
          compatRequestScope: 'classroom-content-review',
        });
        const input = params(model);
        const ordinary = await callLLM(input, 'generate-classroom', undefined, high);
        const review = await callLLM(input, 'generate-classroom', undefined, selected);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(requests.every((r) => r.url === base + '/chat/completions')).toBe(true);
        expect(ordinary.text).toBe('{"fixture":true}');
        expect(review.text).toBe(ordinary.text);
        expect(review.output).toEqual({ fixture: true });
        expect(review.finishReason).toBe('stop');
        const before = requests[0].body;
        const after = requests[1].body;
        expect(before).not.toHaveProperty('enable_thinking');
        expect(after.enable_thinking).toBe(true);
        const { enable_thinking, ...rest } = after;
        expect(enable_thinking).toBe(true);
        expect(rest).toEqual(before);
        expect(after.model).toBe(v41);
        expect(after.max_tokens).toBe(4096);
        expect(after.response_format).toMatchObject({
          type: 'json_schema',
          json_schema: { name: 'classroom_content_response', strict: true },
        });
        for (const key of [
          'reasoning_effort',
          'thinking_budget',
          'thinking',
          'compatRequestScope',
        ]) {
          expect(after).not.toHaveProperty(key);
        }
      },
    );
  }


  it('replaces every configured effort/budget with only the scoped enabled switch', () => {
    const model = makeModel('https://api.siliconflow.cn/v1');
    for (const configured of [undefined, high, disabled]) {
      expect(getClassroomContentThinkingConfig(model, configured)).toEqual({
        mode: 'enabled',
        enabled: true,
        compatRequestScope: 'classroom-content-review',
      });
    }
  });

  it('keeps the private disabled toggle available without inheriting effort or budget', async () => {
    const { requests } = intercept();
    const model = makeModel('https://api.siliconflow.cn/v1');
    const selected = getClassroomContentThinkingConfig(model)!;
    await callLLM(params(model), 'generate-classroom', undefined, {
      ...high,
      ...selected,
      mode: 'disabled',
      enabled: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].body.enable_thinking).toBe(false);
    for (const key of ['reasoning_effort', 'thinking_budget', 'thinking']) {
      expect(requests[0].body).not.toHaveProperty(key);
    }
  });

  it('leaves ordinary high, ordinary disabled and global-disabled V4.1 calls unchanged', async () => {
    const { requests } = intercept();
    const model = makeModel('https://api.siliconflow.cn/v1');
    const input = params(model);
    await callLLM(input, 'generate-classroom');
    await callLLM(input, 'generate-classroom', undefined, high);
    await callLLM(input, 'generate-classroom', undefined, disabled);
    vi.stubEnv('LLM_THINKING_DISABLED', 'true');
    await callLLM(input, 'generate-classroom');
    expect(requests).toHaveLength(4);
    for (const request of requests) expect(request.body).toEqual(requests[0].body);
    expect(requests[0].body).not.toHaveProperty('enable_thinking');
  });

  for (const base of [
    'https://gateway.invalid/v1',
    'https://api.siliconflow.cn.evil.invalid/v1',
    'http://api.siliconflow.cn/v1',
    'https://api.siliconflow.cn:8443/v1',
    'https://api.siliconflow.cn/other',
    'https://api.siliconflow.cn/v1?unexpected=1',
    'https://user:pass@api.siliconflow.cn/v1',
  ]) {
    it('does not add a V4.1 toggle outside the exact official endpoint: ' + base, async () => {
      const { requests } = intercept();
      const model = makeModel(base);
      const input = params(model);
      await callLLM(input, 'generate-classroom', undefined, high);
      await callLLM(
        input,
        'generate-classroom',
        undefined,
        getClassroomContentThinkingConfig(model),
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      for (const key of ['enable_thinking', 'reasoning_effort', 'thinking_budget']) {
        expect(requests[1].body).not.toHaveProperty(key);
      }
    });
  }

  for (const value of [high, disabled]) {
    it('preserves configuration identity for unrelated models: ' + value.mode, () => {
      const model = makeModel('https://api.siliconflow.cn/v1', 'unlisted-model-fixture');
      expect(getClassroomContentThinkingConfig(model, value)).toBe(value);
      expect(getClassroomContentThinkingConfig(undefined as unknown as LanguageModel, value)).toBe(
        value,
      );
    });
  }

  it('does not activate from a wrong or missing private scope', async () => {
    const { requests } = intercept();
    const model = makeModel('https://api.siliconflow.cn/v1');
    const selected = getClassroomContentThinkingConfig(model)!;
    const input = params(model);
    await callLLM(input, 'generate-classroom', undefined, {
      ...selected,
      compatRequestScope: 'other',
    } as unknown as typeof selected);
    await callLLM(input, 'generate-classroom', undefined, {
      ...high,
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => !Object.hasOwn(r.body, 'enable_thinking'))).toBe(true);
  });

  it('isolates V4.1 review, ordinary calls and legacy V4 review concurrently', async () => {
    const { requests } = intercept();
    const fast = makeModel('https://api.siliconflow.cn/v1');
    const legacy = makeModel('https://api.siliconflow.cn/v1', flash);
    await Promise.all([
      callLLM(
        params(fast),
        'generate-classroom',
        undefined,
        getClassroomContentThinkingConfig(fast),
      ),
      callLLM(params(fast), 'generate-classroom', undefined, high),
      callLLM(params(fast), 'generate-classroom', undefined, disabled),
      callLLM(
        params(legacy),
        'generate-classroom',
        undefined,
        getClassroomContentThinkingConfig(legacy, disabled),
      ),
    ]);
    expect(requests).toHaveLength(4);
    const newRequests = requests.filter((r) => r.body.model === v41);
    expect(newRequests.filter((r) => r.body.enable_thinking === true)).toHaveLength(1);
    expect(newRequests.filter((r) => !Object.hasOwn(r.body, 'enable_thinking'))).toHaveLength(2);
    const old = requests.find((r) => r.body.model === flash)!.body;
    expect(old.enable_thinking).toBe(true);
    expect(old.reasoning_effort).toBe('high');
    expect(requests.every((r) => !Object.hasOwn(r.body, 'thinking_budget'))).toBe(true);
  });
});
