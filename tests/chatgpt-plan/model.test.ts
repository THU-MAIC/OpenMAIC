/**
 * The ChatGPT plan model adapter against a scripted Responses API: what goes
 * on the wire, and how failures surface. No network, no database.
 */
import { APICallError, generateText, jsonSchema, streamText, tool } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

interface Sent {
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | undefined;
}
const sent: Sent[] = [];
let answer: (request: Sent, index: number) => Response;

vi.mock('@/lib/server/chatgpt-plan/http', () => ({
  authFetch: vi.fn(),
  inferenceFetch: async (url: string, init: RequestInit) => {
    const request = {
      url,
      authorization: new Headers(init.headers).get('authorization'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    return answer(request, sent.length - 1);
  },
}));

const accessToken = vi.fn(async (rejected?: string) => (rejected ? 'token-2' : 'token-1'));
vi.mock('@/lib/server/chatgpt-plan/session', () => ({
  chatGPTPlanAccessToken: (rejected?: string) => accessToken(rejected),
}));

import { NextRequest } from 'next/server';
import { runFailureCode } from '@/lib/server/generation/run/failure-code';
import { runFailureText } from '@/lib/generation-run-client/failure-message';
import { Type } from 'typebox';
vi.mock('@/lib/server/model-config/saved-provider', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/saved-provider')>()),
  savedChatEndpoint: async () => ({ registryId: 'chatgpt-plan', apiKey: '' }),
}));
import { resolveEvalModel } from '@/eval/shared/resolve-model';
import type { Message as PiMessage } from '@earendil-works/pi-ai';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { callLLM } from '@/lib/ai/llm';
import { attachedModelFallback } from '@/lib/ai/model-fallbacks';
import { slotLanguageModel } from '@/lib/server/model-config/llm';
import { lookupFromLayers } from '@/lib/server/model-config/runtime';
vi.mock('@/lib/server/chatgpt-plan/availability', () => ({
  chatGPTPlanAvailability: () => ({ available: true }),
}));
import { CHATGPT_USAGE_SETTINGS_URL } from '@/lib/chatgpt-plan/shared';
import { ChatGPTPlanError } from '@/lib/server/chatgpt-plan/errors';
import { chatGPTPlanLanguageModel, listChatGPTPlanModels } from '@/lib/server/chatgpt-plan/model';
import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';

const sse = (events: Record<string, unknown>[], headers: Record<string, string> = {}) =>
  new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } },
  );

const created = {
  type: 'response.created',
  response: { id: 'resp_1', created_at: 1764000000, model: 'plan-model' },
};
const usage = { input_tokens: 12, output_tokens: 3 };
const textEvents = (text: string) => [
  created,
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: 'msg_1' },
  },
  {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: text,
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  },
  { type: 'response.completed', response: { usage } },
];
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

const makeSlide = tool({
  description: 'Create a slide',
  inputSchema: jsonSchema<{ title: string }>({
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
  }),
});

beforeEach(() => {
  sent.length = 0;
  accessToken.mockClear();
  answer = () => sse(textEvents('Hello'));
});

describe('ChatGPT plan requests', () => {
  it('stream every call, store nothing, and send only what plan usage accepts', async () => {
    const result = await generateText({
      model: chatGPTPlanLanguageModel('plan-model'),
      system: 'You are an OpenMAIC teacher.',
      messages: [
        { role: 'user', content: 'Make a slide.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call_0',
              toolName: 'make_slide',
              input: { title: 'Intro' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_0',
              toolName: 'make_slide',
              output: { type: 'text', value: 'ok' },
            },
          ],
        },
      ],
      tools: { make_slide: makeSlide },
      maxOutputTokens: 500,
      temperature: 0.3,
      maxRetries: 0,
    });

    expect(result.text).toBe('Hello');
    const [request] = sent;
    expect(request!.url).toBe('https://api.openai.com/v1/responses');
    expect(request!.authorization).toBe('Bearer token-1');
    const body = request!.body!;
    expect(body).toMatchObject({ model: 'plan-model', stream: true, store: false });
    expect(body.instructions).toBe('You are an OpenMAIC teacher.');
    for (const field of ['max_output_tokens', 'temperature', 'top_p', 'previous_response_id']) {
      expect(body).not.toHaveProperty(field);
    }
    const input = body.input as Record<string, unknown>[];
    expect(input.map((item) => item.role ?? item.type)).not.toContain('system');
    expect(input.find((item) => item.type === 'function_call')).toMatchObject({
      namespace: 'openmaic',
    });
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'namespace',
        name: 'openmaic',
        tools: [expect.objectContaining({ type: 'function', name: 'make_slide' })],
      }),
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'unsupported', feature: 'maxOutputTokens' }),
        expect.objectContaining({ type: 'unsupported', feature: 'temperature' }),
      ]),
    );
  });

  it('requires only the selected tool within the application namespace', async () => {
    await generateText({
      model: chatGPTPlanLanguageModel('plan-model'),
      prompt: 'Make a slide.',
      tools: { make_slide: makeSlide, other: makeSlide },
      toolChoice: { type: 'tool', toolName: 'make_slide' },
      maxRetries: 0,
    });
    expect(sent[0]!.body).toMatchObject({
      tool_choice: 'required',
      tools: [{ type: 'namespace', tools: [{ name: 'make_slide' }] }],
    });
  });

  it('resolves a plan slot from the live catalogue and cannot switch billing on failure', async () => {
    const resolution = lookupFromLayers('course.outline', {
      workspace: null,
      deployment: {
        source: 'deployment',
        config: {
          providers: {
            plan: { preset: 'chatgpt-plan' },
            paid: { preset: 'openai', apiKey: 'test' },
          },
          slots: { 'course.outline': { model: 'plan:plan-model', fallback: 'paid:gpt-5.4' } },
        },
      },
    });
    if (resolution.status !== 'assigned') throw new Error('expected assigned plan');
    answer = ({ url }) =>
      url.endsWith('/models')
        ? json(200, {
            models: [
              {
                slug: 'plan-model',
                visibility: 'list',
                input_modalities: ['image', 'text'],
                supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
              },
            ],
          })
        : sse(textEvents('ok'));
    const built = await slotLanguageModel(resolution);
    expect(built.modelInfo?.capabilities?.vision).toBe(true);
    expect(await attachedModelFallback(built.model)?.()).toBeFalsy();
    for (const effort of ['high', 'medium'] as const) {
      await callLLM({ model: built.model, prompt: 'hello' }, 'scene-stream', undefined, { effort });
    }
    expect(sent[1]?.body?.reasoning).toMatchObject({ effort: 'high' });
    expect(sent[2]?.body?.reasoning ?? {}).not.toHaveProperty('effort');
    answer = () => json(429, { error: { code: 'subscription_sharing_usage_limit_exceeded' } });
    await expect(
      callLLM({ model: built.model, prompt: 'hello' }, 'scene-stream', { retries: 2 }),
    ).rejects.toMatchObject({
      statusCode: 429,
      data: { code: 'subscription_sharing_usage_limit_exceeded' },
    });
    expect(sent).toHaveLength(4);
  });

  it('replays the first Pi turn’s encrypted reasoning and namespaced tool result on the second request', async () => {
    const call = {
      type: 'function_call',
      id: 'fc_1',
      name: 'make_slide',
      namespace: 'openmaic',
      call_id: 'call_1',
      arguments: '{"title":"Intro"}',
    };
    answer = (_request, index) =>
      index
        ? sse(textEvents('Done'))
        : sse([
            created,
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'reasoning', id: 'rs_1', summary: [] },
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
            },
            {
              type: 'response.output_item.added',
              output_index: 1,
              item: { ...call, arguments: '' },
            },
            {
              type: 'response.function_call_arguments.delta',
              output_index: 1,
              item_id: 'fc_1',
              delta: call.arguments,
            },
            {
              type: 'response.output_item.done',
              output_index: 1,
              item: { ...call, status: 'completed' },
            },
            { type: 'response.completed', response: { usage } },
          ]);
    const bridge = createCallLlmStreamFn({ languageModel: chatGPTPlanLanguageModel('plan-model') });
    const messages: PiMessage[] = [{ role: 'user', content: 'Make a slide', timestamp: 0 }];
    const run = async () =>
      (
        await bridge({ id: 'plan-model' } as never, {
          messages,
          tools: [
            {
              name: 'make_slide',
              description: 'make slide',
              parameters: Type.Object({ title: Type.String() }),
            },
          ],
        })
      ).result();
    const first = await run();
    expect(first.stopReason).toBe('toolUse');
    messages.push(first, {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'make_slide',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: 1,
    });
    expect((await run()).stopReason).toBe('stop');
    expect(sent[1]?.body?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', encrypted_content: 'opaque' }),
        expect.objectContaining({
          type: 'function_call',
          name: 'make_slide',
          namespace: 'openmaic',
        }),
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
      ]),
    );
  });

  it('streams text through streamText', async () => {
    const result = streamText({
      model: chatGPTPlanLanguageModel('plan-model'),
      prompt: 'hi',
      maxRetries: 0,
    });
    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('Hello');
    expect(sent[0]!.body).toMatchObject({ stream: true, store: false });
  });

  it('refreshes a refused token once and sends the request again', async () => {
    answer = (request) =>
      request.authorization === 'Bearer token-1'
        ? json(401, { error: { code: 'invalid_token', message: 'expired' } })
        : sse(textEvents('Again'));
    const result = await generateText({
      model: chatGPTPlanLanguageModel('plan-model'),
      prompt: 'hi',
      maxRetries: 0,
    });
    expect(result.text).toBe('Again');
    expect(accessToken).toHaveBeenLastCalledWith('token-1');
    expect(sent.map((request) => request.authorization)).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);
  });
});

describe('ChatGPT plan failures', () => {
  const failure = async (maxRetries = 2) => {
    try {
      await generateText({
        model: chatGPTPlanLanguageModel('plan-model'),
        prompt: 'hi',
        maxRetries,
      });
    } catch (error) {
      const last = (error as { lastError?: unknown }).lastError ?? error;
      return last as APICallError;
    }
    throw new Error('expected the call to fail');
  };

  it('reports the usage limit as a quota refusal that is not retried', async () => {
    answer = () =>
      json(
        429,
        {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'echo of the prompt',
          },
        },
        { 'x-request-id': 'req_123' },
      );
    const error = await failure();
    expect(sent).toHaveLength(1);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(error.statusCode).toBe(429);
    expect(error.isRetryable).toBe(false);
    expect(error.cause).toBeInstanceOf(ProviderQuotaExhaustedError);
    expect(error.message).toContain(CHATGPT_USAGE_SETTINGS_URL);
    expect(error.message).toContain('req_123');
    expect(error.message).not.toContain('echo of the prompt');
  });

  it('reads legacy and admission error shapes', async () => {
    answer = () => json(403, { detail: { code: 'subscription_sharing_v2_user_not_eligible' } });
    const error = await failure();
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('This ChatGPT account cannot use its plan in other apps.');
  });

  it('preserves the documented 403 for a route that does not admit plan usage', async () => {
    answer = () => json(403, { error: { code: 'subscription_sharing_route_not_supported' } });
    expect(await failure(0)).toMatchObject({ statusCode: 403, isRetryable: false });
  });

  it('names an unsupported capability by its field', async () => {
    answer = () =>
      json(400, {
        error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0].type' },
      });
    const error = await failure();
    expect(error.message).toContain('tools[0].type');
    expect(error.isRetryable).toBe(false);
  });

  it('fails a response that reports response.failed', async () => {
    answer = () =>
      sse([
        created,
        {
          type: 'response.failed',
          response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'x' } },
        },
      ]);
    const error = await failure(0);
    expect(error.statusCode).toBe(429);
    expect(error.cause).toBeInstanceOf(ProviderQuotaExhaustedError);
  });

  it('rejects incomplete output and gives actionable size errors', async () => {
    answer = () =>
      sse([
        ...textEvents('partial').slice(0, -1),
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' }, usage },
        },
      ]);
    expect((await failure(0)).message).toMatch(/incomplete/i);
    answer = () => json(413, {});
    expect(await failure(0)).toMatchObject({
      statusCode: 413,
      message: expect.stringContaining('fewer attachments'),
    });
  });

  it('fails a stream that ends before the response completes', async () => {
    answer = () => sse(textEvents('partial').slice(0, 3));
    const error = await failure(0);
    expect(error.message).toBe('ChatGPT ended the response before it was complete. Try again.');
  });

  it('reports a connection that has to sign in again', async () => {
    accessToken.mockRejectedValueOnce(new ChatGPTPlanError('reauth-required'));
    const error = await failure();
    expect(sent).toHaveLength(0);
    expect(error.statusCode).toBe(401);
    expect(error.isRetryable).toBe(false);
    expect(error.message).toBe('The ChatGPT connection has expired. Sign in again in settings.');
  });
});

describe('ChatGPT plan models', () => {
  it('resolves an eval model only when the current account lists it', async () => {
    answer = ({ url }) =>
      url.endsWith('/models')
        ? json(200, { models: [{ slug: 'plan-model', visibility: 'list' }] })
        : sse(textEvents('Eval result'));
    const result = await resolveEvalModel('EVAL_PLAN_TEST_MODEL', 'chatgpt-plan:plan-model');
    expect((await generateText({ model: result.model, prompt: 'Hello' })).text).toBe('Eval result');
    await expect(resolveEvalModel('EVAL_PLAN_TEST_MODEL', 'chatgpt-plan:hidden')).rejects.toThrow(
      /unavailable for the connected account/,
    );
  });

  it.each([
    () => new Response('private upstream text'),
    () => json(200, { error: 'private upstream text' }),
    () => json(200, { models: [{}] }),
  ])('reports malformed catalogues without exposing their bodies', async (makeResponse) => {
    answer = makeResponse;
    await expect(listChatGPTPlanModels()).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('invalid model list'),
    });
    answer = () => json(200, { models: [] });
    expect(await listChatGPTPlanModels()).toEqual([]);
  });

  it.each(['classroom', 'verify model list', 'verify inference', 'probe'] as const)(
    'keeps a safe quota response through %s',
    async (entry) => {
      const reason = 'subscription_sharing_usage_limit_exceeded';
      answer = ({ url }) =>
        entry === 'verify inference' && url.endsWith('/models')
          ? json(200, { models: [{ slug: 'plan-model', visibility: 'list' }] })
          : json(429, { error: { code: reason, message: 'private upstream text' } });
      const classroom = entry === 'classroom';
      const { POST } = classroom
        ? await import('@/app/api/chat/pi/route')
        : entry === 'probe'
          ? await import('@/app/api/provider/probe-models/route')
          : await import('@/app/api/verify-model/route');
      const req = new NextRequest('http://localhost/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'chatgpt-plan:plan-model',
          ...(entry === 'probe' ? { provider: 'plan' } : {}),
          ...(classroom
            ? {
                messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
                storeState: { scenes: [] },
                config: { agentIds: ['teacher'] },
              }
            : {}),
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body).toMatchObject({
        errorCode: 'PROVIDER_ACTION_REQUIRED',
        reason,
        error: expect.stringContaining(CHATGPT_USAGE_SETTINGS_URL),
      });
      expect(JSON.stringify(body)).not.toContain('private upstream text');
    },
  );

  it.each(['verify', 'probe'] as const)(
    'asks for ChatGPT sign-in when %s discovers an expired account',
    async (entry) => {
      accessToken.mockRejectedValueOnce(new ChatGPTPlanError('reauth-required'));
      const { POST } =
        entry === 'verify'
          ? await import('@/app/api/verify-model/route')
          : await import('@/app/api/provider/probe-models/route');
      const req = new NextRequest('http://localhost/api/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          entry === 'verify' ? { model: 'chatgpt-plan:plan-model' } : { provider: 'plan' },
        ),
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({
        errorCode: 'PROVIDER_ACTION_REQUIRED',
        reason: 'reauth-required',
        error: expect.stringContaining('Sign in again'),
      });
    },
  );

  it('shows the safe plan recovery in the paused generation preview', async () => {
    answer = () =>
      json(429, {
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          message: 'private upstream text',
        },
      });
    const error = await listChatGPTPlanModels().catch(
      (cause) => new Error('internal wrapper', { cause }),
    );
    const failure = {
      step: 'scene:1:actions',
      message: 'internal wrapper',
      ...runFailureCode(error),
    };
    expect(runFailureText(failure)).toEqual({
      text: expect.stringContaining(CHATGPT_USAGE_SETTINGS_URL),
    });
    expect(JSON.stringify(failure)).not.toContain('internal wrapper');
  });

  it('lists the models the account offers, in server order', async () => {
    answer = () =>
      json(200, {
        models: [
          {
            slug: 'plan-large',
            display_name: 'Plan Large',
            visibility: 'list',
            context_window: 400000,
            input_modalities: ['text', 'image'],
          },
          { slug: 'plan-hidden', visibility: 'hide' },
          { slug: 'plan-internal', visibility: 'list', supported_in_api: false },
          { slug: 'plan-small', visibility: 'list' },
        ],
      });
    expect(await listChatGPTPlanModels()).toEqual([
      { id: 'plan-large', name: 'Plan Large', contextWindow: 400000, vision: true },
      { id: 'plan-small', name: 'plan-small' },
    ]);
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/models');
  });
});
