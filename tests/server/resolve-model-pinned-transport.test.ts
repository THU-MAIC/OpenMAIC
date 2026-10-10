/**
 * LLM calls to a client-supplied base URL run on the pinned provider transport.
 *
 * These tests drive the real `resolveModel`, the real AI SDK model from
 * `getModel`, the real SSRF guard and the real pinned transport against
 * loopback HTTP servers speaking the OpenAI chat-completions protocol. Stubbed:
 *
 *  - `@/lib/server/provider-config`, so each test chooses whether the provider
 *    is server-managed and what the server resolves;
 *  - `node:dns`, so a hostname can answer the URL-layer guard and the
 *    connect-time lookup differently (DNS rebinding); and
 *  - the global `fetch`, a spy that must not be called on the client path.
 */
import type { ServerResponse } from 'node:http';

import { generateText, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveModel } from '@/lib/server/resolve-model';
import { toCallerSafeTransportError } from '@/lib/server/llm-provider-fetch';
import { upstreamHttpStatus } from '@/lib/server/llm-error-response';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closedPort,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  serverManaged: false,
  managedBaseUrl: undefined as string | undefined,
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

// No openmaic.yml policy here: requests may still name their own provider.
vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/runtime')>()),
  requestProvidersAllowed: () => true,
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => mocks.serverManaged,
  resolveApiKey: (_id: string, clientKey: string) => clientKey || 'server-key',
  resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl ?? mocks.managedBaseUrl,
  resolveProxy: () => undefined,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

const CHUNKS = ['Hel', 'lo', ', ', 'pinned', ' world', '!', ' More', ' text', ' here', '.'];
const CHUNK_DELAY_MS = 120;

function sseChunk(content: string | null, finish: string | null = null): string {
  const delta = content === null ? {} : { content };
  return `data: ${JSON.stringify({
    id: 'cmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** An OpenAI-compatible server that streams CHUNKS with a delay between each. */
async function startStreamingServer() {
  const state = { written: 0, finished: false };
  const server = await startLoopback((_req, res: ServerResponse, body) => {
    const request = JSON.parse(body.toString('utf8')) as { stream?: boolean };
    if (!request.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let i = 0;
    const tick = () => {
      if (i < CHUNKS.length) {
        res.write(sseChunk(CHUNKS[i]!));
        state.written = ++i;
        setTimeout(tick, CHUNK_DELAY_MS);
        return;
      }
      res.write(sseChunk(null, 'stop'));
      res.end('data: [DONE]\n\n');
      state.finished = true;
    };
    tick();
  });
  return { ...server, state };
}

async function resolveClientModel(baseUrl: string) {
  const { model } = await resolveModel({
    modelString: 'custom-gateway:test-model',
    providerType: 'openai',
    apiKey: 'client-key',
    baseUrl,
  });
  return model;
}

async function generateError(model: Awaited<ReturnType<typeof resolveClientModel>>) {
  try {
    await generateText({ model, prompt: 'hi', maxRetries: 0 });
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected generateText to fail');
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const originalDefaultModel = process.env.DEFAULT_MODEL;
const globalFetch = vi.fn();

describe('resolveModel with a client-supplied base URL', () => {
  beforeEach(() => {
    mocks.serverManaged = false;
    mocks.managedBaseUrl = undefined;
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    if (originalDefaultModel === undefined) delete process.env.DEFAULT_MODEL;
    else process.env.DEFAULT_MODEL = originalDefaultModel;
    await closeLoopbackServers();
  });

  it('streams a long SSE response incrementally through the pinned transport', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const server = await startStreamingServer();
    const model = await resolveClientModel(`${server.origin}/v1`);

    const result = streamText({ model, prompt: 'hi' });
    const seenAt: number[] = [];
    let text = '';
    for await (const delta of result.textStream) {
      // Record how many chunks the server had written when each delta arrived.
      seenAt.push(server.state.written);
      text += delta;
    }

    expect(text).toBe(CHUNKS.join(''));
    // The first delta arrived long before the server finished writing: the
    // pinned path streams rather than buffering the whole response.
    expect(seenAt[0]).toBeLessThan(CHUNKS.length / 2);
    expect(server.state.finished).toBe(true);
    expect(server.lastUrl()).toBe('/v1/chat/completions');
    expect(server.lastHeaders()!.authorization).toBe('Bearer client-key');
    expect(globalFetch).not.toHaveBeenCalled();
  }, 20_000);

  it('refuses a host that rebinds to loopback between validation and connect', async () => {
    const trap = await startStreamingServer();
    const model = await resolveClientModel(`http://rebind.test:${trap.port}/v1`);

    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toBeDefined();

    expect(mocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
    expect(trap.requests()).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('refuses a redirect and never follows it', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const target = await startStreamingServer();
    const origin = await startLoopback((_req, res) => {
      res.writeHead(307, { Location: `${target.origin}/v1/chat/completions` });
      res.end();
    });
    const model = await resolveClientModel(`${origin.origin}/v1`);

    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toBeDefined();

    expect(origin.requests()).toBe(1);
    expect(target.requests()).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('keeps a server-managed endpoint on the operator transport', async () => {
    // Operator-configured endpoints are trusted and not pinned: a managed
    // loopback endpoint keeps working without ALLOW_LOCAL_NETWORKS.
    vi.unstubAllGlobals();
    const managed = await startStreamingServer();
    mocks.serverManaged = true;
    mocks.managedBaseUrl = `${managed.origin}/v1`;

    const model = await resolveClientModel('http://client-choice.test/v1');
    const result = await generateText({ model, prompt: 'hi', maxRetries: 0 });

    expect(result.text).toBe('OK');
    expect(managed.requests()).toBe(1);
  }, 20_000);

  it.each(['ollama:llama3.3', 'lemonade:Gemma-4-26B-A4B-it-GGUF'])(
    'refuses the local catalog default of an unmanaged %s without the opt-in',
    async (modelString) => {
      await expect(resolveModel({ modelString })).rejects.toThrow(
        /Local\/private network URLs are not allowed/,
      );
    },
  );

  it('pins an unmanaged provider default endpoint when no base URL is sent', async () => {
    const { model } = await resolveModel({ modelString: 'openai:gpt-4o', apiKey: 'client-key' });

    // The connect-time lookup for the catalog host answers loopback: refused.
    const error = await generateError(model);

    expect(error.message).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    expect(mocks.callbackLookup).toHaveBeenCalledWith(
      'api.openai.com',
      expect.anything(),
      expect.any(Function),
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('keeps an operator-selected default model on the operator transport', async () => {
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: { ollama: { preset: 'ollama' } },
          slots: { llm: 'ollama:llama3.3' },
        },
      },
      legacy: true,
      notices: [],
    });
    try {
      const resolved = await resolveModel({ stage: 'quiz-grade' });
      expect(resolved.providerId).toBe('ollama');
      expect(mocks.promisesLookup).not.toHaveBeenCalled();
    } finally {
      runtime.setDeploymentConfigForTests();
    }
  });

  it('reports a refused connection without errno or address detail', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const model = await resolveClientModel(`http://127.0.0.1:${await closedPort()}/v1`);

    const error = await generateError(model);

    expect(error.message).toBe('Cannot connect to API: connection failed');
    expect((error.cause as Error).message).toBe('connection failed');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(
      /ECONNREFUSED|errno|syscall/,
    );
  });

  it.each([
    [401, 'Unauthorized'],
    [429, 'Too Many Requests'],
    [500, 'Internal Server Error'],
  ])('reports HTTP %i by status without the provider response text', async (status, text) => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const provider = await startLoopback((_req, res) => {
      res.writeHead(status, 'internal-secret-reason', { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal-secret-body', type: 'x' } }));
    });
    const model = await resolveClientModel(`${provider.origin}/v1`);

    const error = await generateError(model);

    expect(error.message).toBe(text);
    expect(upstreamHttpStatus(error)).toBe(status);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
      'internal-secret',
    );
  });

  it('reports an HTTP status above 599 as 502', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const provider = await startLoopback((_req, res) => {
      res.writeHead(799, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal-secret-body' } }));
    });
    const model = await resolveClientModel(`${provider.origin}/v1`);

    const error = await generateError(model);

    expect(error.message).toBe('Bad Gateway');
    expect(upstreamHttpStatus(error)).toBe(502);
    expect(error).not.toBeInstanceOf(RangeError);
  });

  it('does not wait for an endless error body', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const timers: ReturnType<typeof setInterval>[] = [];
    let written = 0;
    const provider = await startLoopback((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      const chunk = 'x'.repeat(64 * 1024);
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        res.write(chunk);
        written += chunk.length;
      }, 5);
      timers.push(timer);
      res.on('close', () => clearInterval(timer));
    });
    const model = await resolveClientModel(`${provider.origin}/v1`);

    try {
      const started = Date.now();
      const error = await generateError(model);

      expect(error.message).toBe('Internal Server Error');
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      for (const timer of timers) clearInterval(timer);
    }
    expect(written).toBeGreaterThan(0);
  }, 10_000);

  it('does not wait for a stalled error body', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const provider = await startLoopback((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.write('partial');
      // Never ends the body.
    });
    const model = await resolveClientModel(`${provider.origin}/v1`);

    const started = Date.now();
    const error = await generateError(model);

    expect(error.message).toBe('Internal Server Error');
    expect(Date.now() - started).toBeLessThan(3000);
  }, 10_000);

  it('surfaces a streaming HTTP error without the provider response text', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const provider = await startLoopback((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal-secret-body' } }));
    });
    const model = await resolveClientModel(`${provider.origin}/v1`);

    const errors: unknown[] = [];
    const result = streamText({
      model,
      prompt: 'hi',
      maxRetries: 0,
      onError: ({ error }) => {
        errors.push(error);
      },
    });
    await result.consumeStream();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('Internal Server Error');
    expect(JSON.stringify(errors[0], Object.getOwnPropertyNames(errors[0]))).not.toContain(
      'internal-secret',
    );
  });

  it.each(['?', '#', '?x=/'])('refuses a client base URL ending in %s', async (tail) => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';

    await expect(resolveClientModel(`http://127.0.0.1:9/internal${tail}`)).rejects.toThrow(
      'Base URL must not contain a query string or fragment',
    );
  });
});

describe('toCallerSafeTransportError', () => {
  const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });

  it.each([
    [
      'a timeout',
      Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
      'request timed out',
    ],
    [
      'a resolver failure',
      Object.assign(new Error('getaddrinfo ENOTFOUND internal.example'), { code: 'ENOTFOUND' }),
      'connection failed',
    ],
    ['a refused redirect', new Error('unexpected redirect'), 'redirects are not allowed'],
  ])('maps %s to a fixed cause', (_name, cause, reason) => {
    const mapped = toCallerSafeTransportError(fetchFailed(cause)) as TypeError;

    expect(mapped).toBeInstanceOf(TypeError);
    expect(mapped.message).toBe('fetch failed');
    expect((mapped.cause as Error).message).toBe(reason);
  });

  it('passes a caller abort through unchanged', () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');

    expect(toCallerSafeTransportError(abort)).toBe(abort);
  });
});
