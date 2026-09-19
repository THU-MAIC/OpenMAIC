import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyAgentMock = vi.hoisted(() => ({
  constructions: [] as Array<{ uri: string } & Record<string, unknown>>,
}));

vi.mock('undici', () => ({
  Agent: class {},
  ProxyAgent: class {
    constructor(options: { uri: string } & Record<string, unknown>) {
      proxyAgentMock.constructions.push(options);
    }
  },
  fetch: vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
}));

const googleMock = vi.hoisted(() => ({
  chat: vi.fn((modelId: string) => ({ endpoint: 'google', modelId })),
  createGoogleGenerativeAI: vi.fn(),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: googleMock.createGoogleGenerativeAI,
}));

import { getModel, LLM_FETCH_TIMEOUT_MS } from '@/lib/ai/providers';

describe('Google proxy transport', () => {
  beforeEach(() => {
    googleMock.createGoogleGenerativeAI.mockReset();
    googleMock.createGoogleGenerativeAI.mockReturnValue({ chat: googleMock.chat });
    proxyAgentMock.constructions.length = 0;
  });

  it('builds the proxy dispatcher with the extended LLM timeout budget', async () => {
    getModel({
      providerId: 'google',
      modelId: 'gemini-3.6-flash',
      apiKey: 'g-test',
      proxy: 'http://proxy.example:8080',
    });

    const options = googleMock.createGoogleGenerativeAI.mock.calls.at(-1)?.[0] as {
      fetch?: typeof fetch;
    };
    expect(options?.fetch).toBeTruthy();

    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';
    await options?.fetch?.(url, { method: 'POST' });
    await options?.fetch?.(url, { method: 'POST' });

    // One ProxyAgent for the transport's lifetime, carrying the same
    // headers/body budget as the direct dispatcher. Reverting to the bare
    // string form would drop the budget back to undici's 300 s default and
    // this is the only test that would notice.
    expect(proxyAgentMock.constructions).toHaveLength(1);
    expect(proxyAgentMock.constructions[0]).toMatchObject({
      uri: 'http://proxy.example:8080',
      headersTimeout: LLM_FETCH_TIMEOUT_MS,
      bodyTimeout: LLM_FETCH_TIMEOUT_MS,
    });
  });
});
