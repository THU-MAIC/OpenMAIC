import { Output } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModel } from '@/lib/ai/providers';
import { callLLM } from '@/lib/ai/llm';
import { getClassroomContentThinkingConfig } from '@/lib/server/classroom-content-transport';

vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn(async () => {}) }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const flash = 'deepseek-ai/DeepSeek-V4-Flash';
const disabled = { mode: 'disabled' as const, enabled: false, effort: 'none' as const };
function fixture(baseUrl: string, modelId = flash) {
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(baseUrl + '/chat/completions');
    expect(init?.method).toBe('POST');
    if (typeof init?.body !== 'string') throw new Error('Expected JSON mock request');
    const body = JSON.parse(init.body);
    requests.push(body);
    const chunk = {
      id: 'offline-sf-adapter',
      object: 'chat.completion.chunk',
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: { content: '{"fixture":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
    };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  const { model } = getModel({
    providerId: 'openai',
    modelId,
    baseUrl,
    apiKey: 'offline-fixture-only',
  });
  return {
    requests,
    params: {
      model,
      messages: [{ role: 'user' as const, content: 'Offline wire fixture.' }],
      maxOutputTokens: 4096,
      maxRetries: 0,
      abortSignal: new AbortController().signal,
    },
  };
}

describe('SiliconFlow custom Flash per-call thinking adapter', () => {
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
      'uses the actual vendor toggle only for an explicitly disabled call on ' + base,
      async () => {
        const { params, requests } = fixture(base);
        await callLLM(params, 'generate-classroom');
        await callLLM(
          { ...params, output: Output.json() },
          'generate-classroom',
          undefined,
          disabled,
        );
        expect(requests).toHaveLength(2);
        expect(requests[0]).not.toHaveProperty('enable_thinking');
        expect(requests[1].enable_thinking).toBe(false);
        expect(requests[1]).not.toHaveProperty('reasoning_effort');
        expect(requests[1]).not.toHaveProperty('thinking');
        expect(requests[1].max_tokens).toBe(4096);
        expect(requests[1].response_format).toEqual({ type: 'json_object' });
        const { enable_thinking, response_format, ...review } = requests[1];
        expect(enable_thinking).toBe(false);
        expect(response_format).toEqual({ type: 'json_object' });
        expect(review).toEqual(requests[0]);
      },
    );
  }

  for (const base of [
    'https://gateway.invalid/v1',
    'https://api.siliconflow.cn.evil.invalid/v1',
    'http://api.siliconflow.cn/v1',
    'https://api.siliconflow.cn:8443/v1',
  ]) {
    it('leaves another endpoint untouched: ' + base, async () => {
      const { params, requests } = fixture(base);
      await callLLM(params, 'generate-classroom', undefined, disabled);
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty('enable_thinking');
      expect(requests[0]).not.toHaveProperty('reasoning_effort');
    });
  }

  it('does not invent a toggle for another custom model on the same host', async () => {
    const { params, requests } = fixture('https://api.siliconflow.cn/v1', 'unlisted-offline-model');
    await callLLM(params, 'generate-classroom', undefined, disabled);
    expect(requests[0]).not.toHaveProperty('enable_thinking');
  });

  it('keeps ordinary and disabled calls isolated when they run concurrently', async () => {
    const { params, requests } = fixture('https://api.siliconflow.cn/v1');
    await Promise.all([
      callLLM(params, 'generate-classroom', undefined, disabled),
      callLLM(params, 'generate-classroom'),
      callLLM(params, 'generate-classroom', undefined, { mode: 'enabled', enabled: true }),
    ]);
    expect(requests).toHaveLength(3);
    expect(requests.filter((body) => body.enable_thinking === false)).toHaveLength(1);
    expect(requests.filter((body) => !Object.hasOwn(body, 'enable_thinking'))).toHaveLength(2);
    expect(requests.every((body) => !Object.hasOwn(body, 'reasoning_effort'))).toBe(true);
  });
});

describe('server-scoped complete-content enabled/high wire', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
    vi.stubEnv('LLM_THINKING_DISABLED', 'false');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const ordinaryHigh = { mode: 'enabled' as const, enabled: true, effort: 'high' as const };

  for (const base of ['https://api.siliconflow.cn/v1', 'https://api.siliconflow.com/v1']) {
    it('sends enabled/high only through the actual review scope on ' + base, async () => {
      const { params, requests } = fixture(base);
      const selected = getClassroomContentThinkingConfig(params.model, disabled);
      expect(selected).toEqual({
        mode: 'enabled',
        enabled: true,
        effort: 'high',
        compatRequestScope: 'classroom-content-review',
      });
      await callLLM(
        { ...params, output: Output.json() },
        'generate-classroom',
        undefined,
        ordinaryHigh,
      );
      await callLLM(
        { ...params, output: Output.json() },
        'generate-classroom',
        undefined,
        selected,
      );
      expect(requests).toHaveLength(2);
      expect(requests[0]).not.toHaveProperty('enable_thinking');
      expect(requests[0]).not.toHaveProperty('reasoning_effort');
      expect(requests[1].enable_thinking).toBe(true);
      expect(requests[1].reasoning_effort).toBe('high');
      expect(requests[1]).not.toHaveProperty('thinking_budget');
      expect(requests[1]).not.toHaveProperty('compatRequestScope');
      const { enable_thinking, reasoning_effort, ...rest } = requests[1];
      expect(enable_thinking).toBe(true);
      expect(reasoning_effort).toBe('high');
      expect(rest).toEqual(requests[0]);
    });
  }
  for (const base of [
    'https://gateway.invalid/v1',
    'https://api.siliconflow.cn.evil.invalid/v1',
    'http://api.siliconflow.cn/v1',
    'https://api.siliconflow.cn:8443/v1',
  ]) {
    it('does not apply the scoped alias on another endpoint: ' + base, async () => {
      const { params, requests } = fixture(base);
      await callLLM(
        params,
        'generate-classroom',
        undefined,
        getClassroomContentThinkingConfig(params.model),
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty('enable_thinking');
      expect(requests[0]).not.toHaveProperty('reasoning_effort');
      expect(requests[0]).not.toHaveProperty('thinking_budget');
    });
  }
  it('keeps another model unchanged even if a review-scoped config is passed to it', async () => {
    const { params, requests } = fixture('https://api.siliconflow.cn/v1', 'unlisted-offline-model');
    const known = getModel({
      providerId: 'openai',
      modelId: flash,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'offline-only',
    });
    await callLLM(
      params,
      'generate-classroom',
      undefined,
      getClassroomContentThinkingConfig(known.model),
    );
    expect(requests[0]).not.toHaveProperty('enable_thinking');
    expect(requests[0]).not.toHaveProperty('reasoning_effort');
    expect(getClassroomContentThinkingConfig(params.model, ordinaryHigh)).toBe(ordinaryHigh);
  });
  it('isolates scoped-high, explicit-disabled and ordinary-high simultaneous calls through AsyncLocalStorage', async () => {
    const { params, requests } = fixture('https://api.siliconflow.cn/v1');
    await Promise.all([
      callLLM(
        params,
        'generate-classroom',
        undefined,
        getClassroomContentThinkingConfig(params.model),
      ),
      callLLM(params, 'generate-classroom', undefined, disabled),
      callLLM(params, 'generate-classroom', undefined, ordinaryHigh),
      callLLM(params, 'generate-classroom'),
    ]);
    expect(requests).toHaveLength(4);
    expect(
      requests.filter((body) => body.enable_thinking === true && body.reasoning_effort === 'high'),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (body) => body.enable_thinking === false && !Object.hasOwn(body, 'reasoning_effort'),
      ),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (body) =>
          !Object.hasOwn(body, 'enable_thinking') && !Object.hasOwn(body, 'reasoning_effort'),
      ),
    ).toHaveLength(2);
    expect(
      requests.every(
        (body) =>
          !Object.hasOwn(body, 'thinking_budget') && !Object.hasOwn(body, 'compatRequestScope'),
      ),
    ).toBe(true);
  });
  it('does not activate from a scope marker without the exact enabled/high request', async () => {
    const { params, requests } = fixture('https://api.siliconflow.cn/v1');
    const selected = getClassroomContentThinkingConfig(params.model)!;
    await callLLM(params, 'generate-classroom', undefined, { ...selected, effort: 'max' });
    await callLLM(params, 'generate-classroom', undefined, {
      ...selected,
      mode: 'default',
      enabled: undefined,
    });
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (body) =>
          !Object.hasOwn(body, 'enable_thinking') && !Object.hasOwn(body, 'reasoning_effort'),
      ),
    ).toBe(true);
  });
});

describe('native scene default shape through the actual SDK and existing host guard', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
    vi.stubEnv('LLM_THINKING_DISABLED', 'false');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const sceneDefault = { mode: 'disabled' as const, enabled: false };
  for (const base of [
    'https://api.siliconflow.cn/v1',
    'https://api.siliconflow.com/v1',
    'https://gateway.invalid/v1',
    'https://api.siliconflow.cn.evil.invalid/v1',
    'http://api.siliconflow.cn/v1',
    'https://api.siliconflow.cn:8443/v1',
  ]) {
    it(
      'preserves the ordinary scene body except an allowed exact vendor toggle: ' + base,
      async () => {
        const { params, requests } = fixture(base);
        const ordinary = { ...params, maxOutputTokens: undefined };
        await callLLM(ordinary, 'generate-classroom-scene');
        await callLLM(ordinary, 'generate-classroom-scene', undefined, sceneDefault);
        const official =
          base === 'https://api.siliconflow.cn/v1' || base === 'https://api.siliconflow.com/v1';
        const { enable_thinking, ...rest } = requests[1];
        expect(rest).toEqual(requests[0]);
        if (official) expect(enable_thinking).toBe(false);
        else expect(requests[1]).not.toHaveProperty('enable_thinking');
        for (const body of requests)
          for (const key of [
            'max_tokens',
            'temperature',
            'top_p',
            'thinking_budget',
            'reasoning_effort',
            'response_format',
          ])
            expect(body).not.toHaveProperty(key);
      },
    );
  }
  it('keeps scene-default, ordinary and complete-review contexts isolated concurrently', async () => {
    const { params, requests } = fixture('https://api.siliconflow.cn/v1');
    await Promise.all([
      callLLM(
        { ...params, maxOutputTokens: undefined },
        'generate-classroom-scene',
        undefined,
        sceneDefault,
      ),
      callLLM({ ...params, maxOutputTokens: undefined }, 'generate-classroom-scene'),
      callLLM(
        { ...params, output: Output.json() },
        'generate-classroom',
        undefined,
        getClassroomContentThinkingConfig(params.model),
      ),
    ]);
    expect(requests).toHaveLength(3);
    expect(
      requests.filter((x) => x.enable_thinking === false && !Object.hasOwn(x, 'reasoning_effort')),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (x) => !Object.hasOwn(x, 'enable_thinking') && !Object.hasOwn(x, 'reasoning_effort'),
      ),
    ).toHaveLength(1);
    const review = requests.find((x) => x.enable_thinking === true)!;
    expect(review.reasoning_effort).toBe('high');
    expect(review.max_tokens).toBe(4096);
    expect(review.response_format).toEqual({ type: 'json_object' });
    expect(requests.every((x) => !Object.hasOwn(x, 'thinking_budget'))).toBe(true);
  });
});
