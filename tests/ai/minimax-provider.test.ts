import { afterEach, describe, expect, it, vi } from 'vitest';

import { callLLM } from '@/lib/ai/llm';
import { getModel, getProvider } from '@/lib/ai/providers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MiniMax provider defaults', () => {
  it('uses the Anthropic-compatible v1 endpoint by default', () => {
    expect(getProvider('minimax')?.defaultBaseUrl).toBe('https://api.minimaxi.com/anthropic/v1');
  });

  it('matches the official Anthropic-compatible MiniMax model list', () => {
    const modelIds = getProvider('minimax')?.models.map((model) => model.id) ?? [];
    expect(modelIds).toEqual(['MiniMax-M3', 'MiniMax-M2.7']);
  });

  it('sends Token Plan keys with Bearer auth for the Anthropic-compatible endpoint', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);

      expect(headers.get('authorization')).toBe('Bearer sk-cp-test');
      expect(headers.get('x-api-key')).toBeNull();

      return new Response(
        JSON.stringify({
          type: 'message',
          id: 'msg_test',
          model: 'MiniMax-M3',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { model } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M3',
      apiKey: 'sk-cp-test',
      baseUrl: 'https://api.minimax.io/anthropic/v1',
    });

    await callLLM(
      {
        model,
        prompt: 'hi',
        maxOutputTokens: 10,
      } as Parameters<typeof callLLM>[0],
      'minimax-auth-test',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends MiniMax M3 thinking disablement through the Anthropic-compatible endpoint', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

      expect(body.thinking).toEqual({ type: 'disabled' });

      return new Response(
        JSON.stringify({
          type: 'message',
          id: 'msg_test',
          model: 'MiniMax-M3',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { model } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M3',
      apiKey: 'sk-cp-test',
      baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    });

    await callLLM(
      {
        model,
        prompt: 'hi',
        maxOutputTokens: 10,
      } as Parameters<typeof callLLM>[0],
      'minimax-thinking-test',
      undefined,
      { mode: 'disabled' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not send thinking disablement for fixed-thinking MiniMax models', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

      expect(body.thinking).toBeUndefined();

      return new Response(
        JSON.stringify({
          type: 'message',
          id: 'msg_test',
          model: 'MiniMax-M2.7',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { model } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
      apiKey: 'sk-cp-test',
      baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    });

    await callLLM(
      {
        model,
        prompt: 'hi',
        maxOutputTokens: 10,
      } as Parameters<typeof callLLM>[0],
      'minimax-fixed-thinking-test',
      undefined,
      { mode: 'disabled' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
