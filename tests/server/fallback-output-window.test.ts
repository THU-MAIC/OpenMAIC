import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callLLM, streamLLM } from '@/lib/ai/llm';
import { getModel } from '@/lib/ai/providers';
import { createLogger } from '@/lib/logger';
import { slotLanguageModel } from '@/lib/server/model-config/llm';
import { lookupFromLayers } from '@/lib/server/model-config/runtime';
import { generateOutlines } from '@/lib/server/generation/steps/outline';

// Keep resolution, provider adapters, the SDK and generation steps real.
// Only outbound HTTP and usage persistence are replaced.
const transport = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('@/lib/server/fetch-with-redirect-validation', () => ({
  fetchWithRedirectValidation: transport,
}));
vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn(async () => undefined) }));

const outlineText = '{"languageDirective":"English","outlines":[{"title":"Intro"}]}';
const requests: Array<{ primary: boolean; maxOutputTokens?: number }> = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubEnv('MODEL_FALLBACK', 'google:gemini-3.8-flash');
  vi.stubEnv('GOOGLE_API_KEY', 'test-key');
  transport.mockImplementation(async (input, init) => {
    const url = String(input);
    const primary = url.startsWith('https://api.openai.com/');
    const body = JSON.parse(String(init?.body));
    requests.push({
      primary,
      maxOutputTokens: primary
        ? body.max_completion_tokens
        : body.generationConfig?.maxOutputTokens,
    });
    if (primary) {
      return Response.json(
        { error: { message: 'Quota exhausted', code: 'insufficient_quota' } },
        { status: 429 },
      );
    }
    const result = {
      candidates: [
        { content: { role: 'model', parts: [{ text: outlineText }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };
    return url.includes('streamGenerateContent')
      ? new Response(`data: ${JSON.stringify(result)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      : Response.json(result);
  });
});

afterEach(() => vi.unstubAllEnvs());

async function primaryModel(route: 'slot' | 'global', fallback = 'gemini-3.8-flash') {
  if (route === 'global') {
    const built = getModel({
      providerId: 'openai',
      modelId: 'gpt-5.4',
      apiKey: 'test-key',
      fetchImpl: transport,
    });
    return { ...built, modelString: 'openai:gpt-5.4', serverManaged: true };
  }
  const resolution = lookupFromLayers('course.outline', {
    workspace: null,
    deployment: {
      source: 'deployment',
      config: {
        providers: {
          primary: { preset: 'openai', apiKey: 'test-key' },
          backup: { preset: 'google', apiKey: 'test-key' },
        },
        slots: { 'course.outline': { model: 'primary:gpt-5.4', fallback: `backup:${fallback}` } },
      },
    },
  });
  if (resolution.status !== 'assigned') throw new Error('Test slot must be assigned');
  return slotLanguageModel(resolution);
}

async function streamed(
  model: Awaited<ReturnType<typeof primaryModel>>['model'],
  maxOutputTokens?: number,
  source = 'test-stream',
) {
  let text = '';
  for await (const part of streamLLM(
    { model, prompt: 'hello', maxOutputTokens, maxRetries: 0 },
    source,
  ).fullStream) {
    if (part.type === 'error') throw part.error;
    if (part.type === 'text-delta') text += part.text;
  }
  return text;
}

describe('fallback output window at the provider boundary', () => {
  it.each(['slot', 'global'] as const)('caps generated text on the %s fallback', async (route) => {
    const primary = await primaryModel(route);
    const result = await callLLM(
      { model: primary.model, prompt: 'hello', maxOutputTokens: 128000 },
      'test-generate',
      undefined,
      undefined,
      { serverManaged: true },
    );
    expect(result.text).toBe(outlineText);
    expect(requests).toEqual([
      { primary: true, maxOutputTokens: 128000 },
      { primary: false, maxOutputTokens: 65536 },
    ]);
  });

  it('caps a streamed slot fallback', async () => {
    const primary = await primaryModel('slot');
    expect(await streamed(primary.model, 128000)).toBe(outlineText);
    expect(requests).toEqual([
      { primary: true, maxOutputTokens: 128000 },
      { primary: false, maxOutputTokens: 65536 },
    ]);
  });

  it.each(['slot', 'global'] as const)("caps the outline step's own %s fallback", async (route) => {
    const primary = await primaryModel(route);
    const result = await generateOutlines(
      { requirements: { requirement: 'Teach photosynthesis' }, model: primary },
      {
        log: createLogger('FallbackWindowTest'),
        workspaceId: null,
        resolveVisionImages: async () => [],
      },
    );
    expect(result.outlines).toMatchObject([{ title: 'Intro' }]);
    expect(requests).toEqual([
      { primary: true, maxOutputTokens: 128000 },
      { primary: false, maxOutputTokens: 65536 },
    ]);
  });

  it.each([
    ['smaller caller limit', 'gemini-3.8-flash', 1024, 1024],
    ['no caller limit', 'gemini-3.8-flash', undefined, 65536],
    ['unknown fallback limit', 'custom-model', 128000, 128000],
    ['both limits unknown', 'custom-model', undefined, undefined],
  ] as const)(
    'preserves %s for generated and streamed text',
    async (_case, fallback, requested, expected) => {
      const primary = await primaryModel('slot', fallback);
      const result = await callLLM(
        { model: primary.model, prompt: 'hello', maxOutputTokens: requested },
        'test-generate',
      );
      expect(result.text).toBe(outlineText);
      expect(await streamed(primary.model, requested)).toBe(outlineText);
      expect(requests.filter((r) => !r.primary).map((r) => r.maxOutputTokens)).toEqual([
        expected,
        expected,
      ]);
    },
  );

  it.each([
    ['omitted', undefined, 4096],
    ['explicit', 200000, 262144],
  ] as const)(
    'preserves an %s limit on a compatible endpoint with an OpenAI model name',
    async (_case, requested, endpointLimit) => {
      vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
      const defaultTransport = transport.getMockImplementation()!;
      transport.mockImplementation(async (input, init) => {
        if (!String(input).startsWith('https://compat.example.test/')) {
          return defaultTransport(input, init);
        }
        const body = JSON.parse(String(init?.body));
        requests.push({ primary: false, maxOutputTokens: body.max_completion_tokens });
        if (body.max_completion_tokens > endpointLimit) {
          return Response.json(
            { error: { message: "Output limit exceeds this endpoint's capacity" } },
            { status: 400 },
          );
        }
        const result = {
          id: 'chatcmpl-compat',
          object: body.stream ? 'chat.completion.chunk' : 'chat.completion',
          created: 1,
          model: 'gpt-5.6',
          choices: [
            {
              index: 0,
              [body.stream ? 'delta' : 'message']: { role: 'assistant', content: outlineText },
              finish_reason: 'stop',
            },
          ],
        };
        return body.stream
          ? new Response(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            })
          : Response.json(result);
      });
      const resolution = lookupFromLayers('agent', {
        workspace: null,
        deployment: {
          source: 'deployment',
          config: {
            providers: {
              primary: { preset: 'openai', apiKey: 'test-key' },
              backup: { preset: 'openai-compatible', baseUrl: 'https://compat.example.test/v1' },
            },
            slots: { agent: { model: 'primary:gpt-5.4', fallback: 'backup:gpt-5.6' } },
          },
        },
      });
      if (resolution.status !== 'assigned') throw new Error('Test slot must be assigned');
      const primary = await slotLanguageModel(resolution);
      const result = await callLLM(
        { model: primary.model, prompt: 'hello', maxOutputTokens: requested },
        'pbl-learning-report',
      );
      expect(result.text).toBe(outlineText);
      expect(await streamed(primary.model, requested)).toBe(outlineText);
      expect(requests).toEqual([
        { primary: true, maxOutputTokens: requested },
        { primary: false, maxOutputTokens: requested },
        { primary: true, maxOutputTokens: requested },
        { primary: false, maxOutputTokens: requested },
      ]);
    },
  );
});

describe('model identity probes', () => {
  it.each(['eval-outline-language', 'eval-whiteboard', 'verify-model'])(
    'does not use an attached fallback for %s, generated or streamed',
    async (source) => {
      const primary = await primaryModel('slot');
      await expect(callLLM({ model: primary.model, prompt: 'hello' }, source)).rejects.toThrow(
        'Quota exhausted',
      );
      await expect(streamed(primary.model, undefined, source)).rejects.toThrow('Quota exhausted');
      expect(requests.map((r) => r.primary)).toEqual([true, true]);
    },
  );

  it('does not use MODEL_FALLBACK for eval even when server-managed is enabled', async () => {
    const primary = await primaryModel('global');
    await expect(
      callLLM(
        { model: primary.model, prompt: 'hello' },
        'eval-outline-language',
        undefined,
        undefined,
        { serverManaged: true },
      ),
    ).rejects.toThrow('Quota exhausted');
    expect(requests.map((r) => r.primary)).toEqual([true]);
  });
});
