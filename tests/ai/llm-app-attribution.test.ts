import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAiMock = vi.hoisted(() => ({
  chat: vi.fn((modelId: string) => ({ endpoint: 'chat', modelId })),
  responses: vi.fn((modelId: string) => ({ endpoint: 'responses', modelId })),
  createOpenAI: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: openAiMock.createOpenAI,
}));

import { getModel } from '@/lib/ai/providers';
import { APP_ATTRIBUTION_URL } from '@/lib/config/app-attribution';

/**
 * The LLM transport seam (transportFetch in providers.ts) must attach the
 * TokenDance app-attribution header to every outbound request whose target is
 * the TokenDance gateway — whatever provider SDK / api-format ends up riding
 * it — and must leave requests to every other provider untouched.
 */
describe('LLM transport app attribution', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'false');
    openAiMock.createOpenAI.mockReset();
    openAiMock.createOpenAI.mockReturnValue({
      chat: openAiMock.chat,
      responses: openAiMock.responses,
    });
  });

  it('sends X-App-URL to the TokenDance gateway and nowhere else', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    try {
      globalThis.fetch = fetchMock as typeof fetch;

      getModel({ providerId: 'tokendance', modelId: 'glm-5.3', apiKey: 'sk-test' });
      const options = openAiMock.createOpenAI.mock.calls.at(-1)?.[0] as {
        fetch?: typeof fetch;
      };

      await options?.fetch?.('https://tokendance.space/gateway/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-test' },
      });
      let headers = new Headers(
        (fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.headers,
      );
      expect(headers.get('x-app-url')).toBe(APP_ATTRIBUTION_URL);
      // The caller's own headers survive the merge.
      expect(headers.get('authorization')).toBe('Bearer sk-test');

      await options?.fetch?.('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer sk-test' },
      });
      headers = new Headers((fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined)?.headers);
      expect(headers.get('x-app-url')).toBeNull();
      expect(headers.get('authorization')).toBe('Bearer sk-test');
    } finally {
      globalThis.fetch = originalFetch;
      vi.unstubAllEnvs();
    }
  });
});
