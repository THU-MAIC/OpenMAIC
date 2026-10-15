import { NoObjectGeneratedError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLLM } from '@/lib/ai/llm';
import { getModel } from '@/lib/ai/providers';
import {
  CLASSROOM_CONTENT_MAX_OUTPUT_TOKENS,
  getClassroomContentOutputOptions,
  getClassroomContentThinkingConfig,
} from '@/lib/server/classroom-content-transport';
import {
  CLASSROOM_CONTENT_REVIEW_VERSION,
  createClassroomContentCallbacks,
  reviewClassroomContent,
  type ClassroomReviewPacket,
} from '@/lib/server/classroom-content-review';

vi.mock('@/lib/server/usage-storage', () => ({
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Actual SDK, OpenAI v3 adapter, callLLM and gateway SSE conversion run below.
// The sole transport is a controlled fetch mock; these fixtures prove no facts.
const modelId = 'deepseek-ai/DeepSeek-V4-Flash';
// Official public hostname is a controlled fetch fixture, never a live request.
const fakeBaseUrl = 'https://api.siliconflow.cn/v1';
function providerResponse(text: string, responseModelId = modelId, finishReason = 'stop') {
  const chunk = {
    id: 'chatcmpl-offline-json',
    object: 'chat.completion.chunk',
    created: 1,
    model: responseModelId,
    choices: [
      { index: 0, delta: { role: 'assistant', content: text }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };
  return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
function intercept(text: string, baseUrl = fakeBaseUrl) {
  const requests: Array<{ body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(baseUrl + '/chat/completions');
    expect(init?.method).toBe('POST');
    if (typeof init?.body !== 'string') throw new Error('Unexpected non-JSON mock request');
    const body = JSON.parse(init.body);
    requests.push({ body, signal: init.signal });
    return providerResponse(text, String(body.model));
  });
  vi.stubGlobal('fetch', fetch);
  return { requests, fetch };
}
function parameters(requestModelId = modelId, maxOutputTokens = 4096, baseUrl = fakeBaseUrl) {
  const controller = new AbortController();
  const { model } = getModel({
    providerId: 'openai',
    modelId: requestModelId,
    baseUrl,
    apiKey: 'unit-test-only-not-a-live-key',
  });
  return {
    model,
    messages: [
      { role: 'system' as const, content: 'Offline transport contract only.' },
      { role: 'user' as const, content: 'Preserve exact output bytes.' },
    ],
    maxOutputTokens,
    maxRetries: 0,
    abortSignal: controller.signal,
  };
}

describe('native complete-content JSON SDK transport', () => {
  beforeEach(() => {
    // Hermetic test-only gateway flag; production configuration is never loaded.
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
    vi.stubEnv('LLM_THINKING_DISABLED', 'false');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends real json_object through the existing SSE gateway and leaves ordinary request options unchanged', async () => {
    const raw = ' \n{"contract":"transport-only","text":"&lt;x&gt;\\\\n"}\n ';
    const { requests, fetch } = intercept(raw);
    const params = parameters();
    const thinking = { enabled: true, effort: 'high' as const };
    const ordinary = await callLLM(params, 'generate-classroom', undefined, thinking);
    const review = await callLLM(
      { ...params, ...getClassroomContentOutputOptions() },
      'generate-classroom',
      undefined,
      thinking,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ordinary.text).toBe(raw);
    expect(review.text).toBe(raw);
    expect(review.output).toEqual(JSON.parse(raw));
    expect(requests[0].body).not.toHaveProperty('response_format');
    expect(requests[1].body.response_format).toEqual({ type: 'json_object' });
    const { response_format, ...reviewBody } = requests[1].body;
    expect(response_format).toEqual({ type: 'json_object' });
    expect(reviewBody).toEqual(requests[0].body);
    expect(reviewBody.model).toBe(modelId);
    expect(reviewBody.stream).toBe(true);
    expect(reviewBody.stream_options).toEqual({ include_usage: true });
    expect(requests.every(({ signal }) => signal instanceof AbortSignal && !signal.aborted)).toBe(
      true,
    );
  });

  for (const raw of ['```json\n{"contract":"fenced"}\n```', '{"contract":']) {
    it(
      'rejects invalid JSON without unwrapping or normalizing the provider text: ' +
        raw.slice(0, 12),
      async () => {
        const { requests, fetch } = intercept(raw);
        const params = parameters();
        await expect(
          callLLM(
            { ...params, ...getClassroomContentOutputOptions() },
            'generate-classroom',
            undefined,
            { enabled: true },
          ),
        ).rejects.toBeInstanceOf(NoObjectGeneratedError);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(requests[0].body.response_format).toEqual({ type: 'json_object' });
      },
    );
  }

  it('does not send a vendor thinking toggle to a different host for the same uncatalogued custom model', async () => {
    const raw = JSON.stringify({ contract: 'wire-only' });
    const otherBase = 'https://classroom-json.invalid/v1';
    const { requests, fetch } = intercept(raw, otherBase);
    const params = parameters(modelId, 16384, otherBase);
    await callLLM(params, 'generate-classroom', undefined, {
      mode: 'disabled',
      enabled: false,
      effort: 'none',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests[0].body.max_tokens).toBe(16384);
    expect(requests[0].body).not.toHaveProperty('reasoning_effort');
    expect(requests[0].body).not.toHaveProperty('thinking');
    expect(requests[0].body).not.toHaveProperty('enable_thinking');
  });

  it('bounds both content callbacks and selects scoped enabled/high on the official wire without changing ordinary generation', async () => {
    // Opaque transport fixtures exercise callbacks and SDK, not factual gate acceptance.
    const raw = JSON.stringify({ contract: 'budget-wire', text: '&lt;x&gt;\n' });
    const { requests, fetch } = intercept(raw);
    const params = parameters(modelId, 16384);
    const thinking = { mode: 'enabled' as const, enabled: true, effort: 'high' as const };
    expect(params.model).toMatchObject({ provider: 'openai.chat', modelId });
    const ordinary = await callLLM(params, 'generate-classroom', undefined, thinking);
    const selectedThinking = getClassroomContentThinkingConfig(params.model, thinking);
    expect(selectedThinking).toEqual({
      mode: 'enabled',
      enabled: true,
      effort: 'high',
      compatRequestScope: 'classroom-content-review',
    });
    expect(getClassroomContentOutputOptions(params.model)).not.toHaveProperty('providerOptions');
    const callbacks = createClassroomContentCallbacks(async (systemPrompt, userPrompt) => {
      const result = await callLLM(
        {
          ...params,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          ...getClassroomContentOutputOptions(params.model),
        },
        'generate-classroom',
        undefined,
        selectedThinking,
      );
      return result.text;
    });
    const packet: ClassroomReviewPacket = {
      requirements: { requirement: 'Offline transport fixture only.' },
      material: {
        stage: { id: 'offline-stage' },
        scenes: [{ id: 'offline-scene', type: 'slide', content: { text: '&lt;raw&gt;\n' } }],
      },
      binding: {
        reviewVersion: CLASSROOM_CONTENT_REVIEW_VERSION,
        reportVersion: 1,
        sourceDigest: 'a'.repeat(64),
        materialDigest: 'b'.repeat(64),
        reviewSnapshotDigest: 'c'.repeat(64),
        sceneIds: ['offline-scene'],
        sourceScope: 'general_requirements_only',
        mutableSpeechAudioFields: [],
      },
      fieldPathCatalog: [
        {
          sceneId: 'offline-scene',
          fields: [{ fieldRef: 'f_' + 'd'.repeat(32), path: '/content/text' }],
        },
      ],
    };
    const repairPacket = {
      ...packet,
      findings: [
        {
          fieldRef: 'f_' + 'd'.repeat(32),
          sceneId: 'offline-scene',
          path: '/content/text',
          quotedText: '&lt;raw&gt;\n',
          reason: 'Opaque transport fixture.',
          requiredChange: 'Opaque transport fixture.',
          kind: 'text' as const,
          affectsCode: false,
          affectsRoot: false,
        },
      ],
    };
    expect(await callbacks.review(packet)).toBe(raw);
    if (!callbacks.repair) throw new Error('Expected the actual repair callback');
    expect(await callbacks.repair(repairPacket)).toBe(raw);
    expect(ordinary.text).toBe(raw);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(requests[0].body.max_tokens).toBe(16384);
    expect(requests[0].body).not.toHaveProperty('reasoning_effort');
    expect(requests[0].body).not.toHaveProperty('response_format');
    expect(requests[0].body).not.toHaveProperty('enable_thinking');
    for (const { body, signal } of requests.slice(1)) {
      expect(body.max_tokens).toBe(CLASSROOM_CONTENT_MAX_OUTPUT_TOKENS);
      expect(body.max_tokens).toBe(4096);
      expect(body.enable_thinking).toBe(true);
      expect(body.reasoning_effort).toBe('high');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.model).toBe(modelId);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body).not.toHaveProperty('temperature');
      expect(signal instanceof AbortSignal && !signal.aborted).toBe(true);
      const { messages, max_tokens, enable_thinking, reasoning_effort, response_format, ...rest } =
        body;
      expect(messages).toHaveLength(2);
      expect(max_tokens).toBe(4096);
      expect(enable_thinking).toBe(true);
      expect(reasoning_effort).toBe('high');
      expect(response_format).toEqual({ type: 'json_object' });
      const {
        messages: ordinaryMessages,
        max_tokens: ordinaryLimit,
        ...ordinaryRest
      } = requests[0].body;
      expect(ordinaryMessages).toHaveLength(2);
      expect(ordinaryLimit).toBe(16384);
      expect(rest).toEqual(ordinaryRest);
    }
    expect((requests[1].body.messages as Array<{ content: string }>)[1].content).toBe(
      JSON.stringify(packet),
    );
    expect((requests[2].body.messages as Array<{ content: string }>)[1].content).toBe(
      JSON.stringify(repairPacket),
    );
  });

  it('retains a different model configured thinking on actual SDK wire and scopes only its content output cap', async () => {
    const { requests, fetch } = intercept(JSON.stringify({ contract: 'other-model-wire' }));
    const params = parameters('gpt-5.6', 16384);
    const thinking = { mode: 'enabled' as const, enabled: true, effort: 'high' as const };
    const selectedThinking = getClassroomContentThinkingConfig(params.model, thinking);
    expect(selectedThinking).toBe(thinking);
    expect(getClassroomContentOutputOptions(params.model)).not.toHaveProperty('providerOptions');
    await callLLM(params, 'generate-classroom', undefined, thinking);
    await callLLM(
      { ...params, ...getClassroomContentOutputOptions(params.model) },
      'generate-classroom',
      undefined,
      selectedThinking,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests[0].body.reasoning_effort).toBe('high');
    expect(requests[1].body.reasoning_effort).toBe('high');
    expect(requests[0].body.max_completion_tokens).toBe(16384);
    expect(requests[1].body.max_completion_tokens).toBe(4096);
    const { max_completion_tokens, response_format, ...reviewBody } = requests[1].body;
    expect(max_completion_tokens).toBe(4096);
    expect(response_format).toEqual({ type: 'json_object' });
    const { max_completion_tokens: ordinaryLimit, ...ordinaryBody } = requests[0].body;
    expect(ordinaryLimit).toBe(16384);
    expect(reviewBody).toEqual(ordinaryBody);
  });
});

function sdkMaterial() {
  return {
    stage: { id: 'sdk-stage' },
    scenes: [
      {
        id: 'sdk-scene',
        stageId: 'sdk-stage',
        type: 'slide',
        title: 'Literal offline fixture',
        content: {
          type: 'slide',
          canvas: { elements: [{ id: 'text', type: 'text', content: '<p>&lt;x&gt;</p>' }] },
        },
        actions: [{ id: 'speech', type: 'speech', text: 'Old fixture speech' }],
      },
    ],
  };
}
function sdkRef(packet: ClassroomReviewPacket) {
  const field = packet.fieldPathCatalog[0].fields.find((item) => item.path === '/actions/0/text');
  if (!field) throw new Error('SDK fixture field missing');
  return field.fieldRef;
}
function sdkBinding(packet: ClassroomReviewPacket) {
  return {
    review_version: packet.binding.reviewVersion,
    source_digest: packet.binding.sourceDigest,
    material_digest: packet.binding.materialDigest,
    review_snapshot_digest: packet.binding.reviewSnapshotDigest,
  };
}
function sdkReview(packet: ClassroomReviewPacket, findings: unknown[] = []) {
  return JSON.stringify({
    ...sdkBinding(packet),
    content_pass: findings.length === 0,
    reviewed_scene_ids: packet.binding.sceneIds,
    findings,
  });
}
function sdkFinding(packet: ClassroomReviewPacket, ref = sdkRef(packet)) {
  return {
    field_ref: ref,
    reason: 'Offline deliberate prose fixture.',
    required_change: 'Use the new fixture speech.',
    kind: 'text',
    affects_code: false,
    affects_root: false,
  };
}
function structuredSdkFixture(
  reply: (packet: ClassroomReviewPacket, index: number) => string,
  finishReason = 'stop',
  rejectRequest = false,
) {
  const requests: Array<Record<string, unknown>> = [],
    errors: unknown[] = [],
    returnedRaw: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe(fakeBaseUrl + '/chat/completions');
    expect(init?.method).toBe('POST');
    if (typeof init?.body !== 'string') throw new Error('Expected actual SDK JSON body');
    const body = JSON.parse(init.body);
    requests.push(body);
    if (rejectRequest)
      return new Response(
        JSON.stringify({ error: { message: 'Offline schema unsupported fixture' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    const message = (body.messages as Array<{ role: string; content: string }>).find(
      (item) => item.role === 'user',
    );
    if (!message) throw new Error('Expected actual packet message');
    const packet = JSON.parse(message.content) as ClassroomReviewPacket;
    return providerResponse(reply(packet, requests.length - 1), String(body.model), finishReason);
  });
  vi.stubGlobal('fetch', fetch);
  const params = parameters(modelId, 16384);
  const fallback = vi.fn(async () => {
    throw new Error('Unexpected JSON-mode fallback');
  });
  const callbacks = createClassroomContentCallbacks(fallback, {
    structuredCall: async (system, user, schema) => {
      try {
        const result = await callLLM(
          {
            ...params,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            ...getClassroomContentOutputOptions(params.model, schema),
          },
          'generate-classroom',
          undefined,
          getClassroomContentThinkingConfig(params.model, {
            mode: 'enabled',
            enabled: true,
            effort: 'high',
          }),
        );
        returnedRaw.push(result.text);
        return result.text;
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  });
  return { requests, fetch, callbacks, fallback, errors, returnedRaw };
}

describe('actual SDK dynamic server packet schema transport', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
    vi.stubEnv('LLM_THINKING_DISABLED', 'false');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends strict packet enums for review, listed-only repair and a complete new review through the real SDK', async () => {
    const setup = structuredSdkFixture((packet, index) =>
      index === 0
        ? sdkReview(packet, [sdkFinding(packet)])
        : index === 1
          ? JSON.stringify({
              ...sdkBinding(packet),
              patches: [{ field_ref: sdkRef(packet), new_text: 'New fixture speech' }],
            })
          : sdkReview(packet),
    );
    const result = await reviewClassroomContent({
      requirements: { requirement: 'Literal offline source only.' },
      material: sdkMaterial(),
      callbacks: setup.callbacks,
    });
    expect(result.material.scenes[0].actions[0].text).toBe('New fixture speech');
    expect(setup.fetch).toHaveBeenCalledTimes(3);
    expect(setup.fallback).not.toHaveBeenCalled();
    expect(setup.errors).toHaveLength(0);
    const packets = setup.requests.map(
      (body) =>
        JSON.parse(
          (body.messages as Array<{ role: string; content: string }>).find(
            (message) => message.role === 'user',
          )!.content,
        ) as ClassroomReviewPacket,
    );
    const schemas = setup.requests.map((body) => JSON.parse(JSON.stringify(body.response_format)));
    for (const [index, body] of setup.requests.entries()) {
      expect(schemas[index].type).toBe('json_schema');
      expect(schemas[index].json_schema.strict).toBe(true);
      expect(schemas[index].json_schema.name).toBe('classroom_content_response');
      expect(body.max_tokens).toBe(4096);
      expect(body.enable_thinking).toBe(true);
      expect(body.reasoning_effort).toBe('high');
      expect(body).not.toHaveProperty('temperature');
      const properties = schemas[index].json_schema.schema.properties;
      expect(properties.source_digest.enum).toEqual([packets[index].binding.sourceDigest]);
      expect(properties.material_digest.enum).toEqual([packets[index].binding.materialDigest]);
      expect(properties.review_snapshot_digest.enum).toEqual([
        packets[index].binding.reviewSnapshotDigest,
      ]);
      if (index === 1)
        expect(properties.patches.items.properties.field_ref.enum).toEqual([
          sdkRef(packets[index]),
        ]);
      else
        expect(properties.findings.items.properties.field_ref.enum).toEqual(
          packets[index].fieldPathCatalog.flatMap((scene) =>
            scene.fields.map((field) => field.fieldRef),
          ),
        );
    }
    expect(sdkRef(packets[2])).not.toBe(sdkRef(packets[0]));
    expect(
      schemas[2].json_schema.schema.properties.findings.items.properties.field_ref.enum,
    ).not.toContain(sdkRef(packets[0]));
  });

  for (const finishReason of ['stop', 'length']) {
    it(
      'rejects a fabricated enum member without fallback and preserves raw text when finish is ' +
        finishReason,
      async () => {
        let raw = '';
        const setup = structuredSdkFixture((packet) => {
          raw = ' \n' + sdkReview(packet, [sdkFinding(packet, 'f_' + '0'.repeat(32))]) + '\n ';
          return raw;
        }, finishReason);
        const record = vi.fn(async () => {});
        await expect(
          reviewClassroomContent({
            requirements: { requirement: 'Offline enum rejection only.' },
            material: sdkMaterial(),
            callbacks: setup.callbacks,
            record,
          }),
        ).rejects.toMatchObject({ code: 'review_unavailable' });
        expect(setup.fetch).toHaveBeenCalledTimes(1);
        expect(setup.fallback).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
        if (finishReason === 'stop') {
          expect(setup.errors).toHaveLength(1);
          expect(NoObjectGeneratedError.isInstance(setup.errors[0])).toBe(true);
          expect((setup.errors[0] as NoObjectGeneratedError).text).toBe(raw);
        } else {
          // This installed SDK skips complete object validation on length; the
          // original raw helper parser remains an independent mandatory guard.
          expect(setup.returnedRaw).toEqual([raw]);
        }
      },
    );
  }

  it('fails a provider schema rejection after one request without downgrading to JSON mode or retrying', async () => {
    const setup = structuredSdkFixture((packet) => sdkReview(packet), 'stop', true);
    await expect(
      reviewClassroomContent({
        requirements: { requirement: 'Offline unsupported-schema fixture.' },
        material: sdkMaterial(),
        callbacks: setup.callbacks,
      }),
    ).rejects.toMatchObject({ code: 'review_unavailable' });
    expect(setup.fetch).toHaveBeenCalledTimes(1);
    expect(setup.fallback).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(setup.requests[0].response_format)).type).toBe('json_schema');
  });
});
