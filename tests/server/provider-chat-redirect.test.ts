/**
 * End-to-end proof for the affected outbound path: a chat-completion model
 * built the way resolveModel builds one (openai-compatible, client-supplied
 * base URL, redirect-validating fetch installed) must re-validate every
 * redirect hop the origin answers with. DNS lookups are stubbed like the
 * ssrf-guard tests; the fetch transport is a stub recording every URL it was
 * asked to open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: {
    lookup: lookupMock,
  },
}));

import { fetchWithRedirectValidation } from '@/lib/server/fetch-with-redirect-validation';
import { getModel } from '@/lib/ai/providers';

function chatCompletionBody(text: string): string {
  return JSON.stringify({
    id: 'chatcmpl-redirect-test',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

describe('chat-completion model fetch re-validates redirect hops', () => {
  beforeEach(() => {
    vi.resetModules();
    lookupMock.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === 'cdn.public.example') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      throw new Error(`ENOTFOUND ${hostname}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALLOW_LOCAL_NETWORKS;
  });

  it('never lets a 302 to a loopback address be followed during generation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/steal-key' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { model } = getModel({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
      baseUrl: 'https://api.public.example/v1',
      fetchImpl: fetchWithRedirectValidation,
    });

    await expect(
      generateText({
        model,
        prompt: 'hi',
        maxRetries: 0,
      }),
    ).rejects.toThrow();

    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requestedUrls).toEqual(['https://api.public.example/v1/chat/completions']);
    expect(requestedUrls.join(' ')).not.toContain('127.0.0.1');
    // The redirect-validating transport requested manual redirect handling;
    // nothing followed the 302 on its own.
    expect((fetchMock.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
  });

  it('follows a 302 to another public address and completes generation against it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.public.example/v1/chat/completions' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(chatCompletionBody('redirected ok'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { model } = getModel({
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
      baseUrl: 'https://api.public.example/v1',
      fetchImpl: fetchWithRedirectValidation,
    });

    const result = await generateText({
      model,
      prompt: 'hi',
      maxRetries: 0,
    });

    expect(result.text).toBe('redirected ok');
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://cdn.public.example/v1/chat/completions',
    );
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).redirect).toBe('manual');
    }
  });
});
