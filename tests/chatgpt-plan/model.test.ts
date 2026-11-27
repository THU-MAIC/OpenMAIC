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
