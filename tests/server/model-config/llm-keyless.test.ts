/**
 * A self-hosted OpenAI-compatible server without a key (Ollama, vLLM declared
 * in openmaic.yml as `preset: openai-compatible` with no `apiKey`): the slot
 * model builds and its requests carry no Authorization header. OpenAI itself
 * still needs a key.
 */
import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { getModel, withoutEmptyBearer } from '@/lib/ai/providers';
import { languageModelFor } from '@/lib/server/model-config/llm';
import type { ResolvedModelTarget } from '@/lib/server/model-config/resolve-slot';

const target = (overrides: Partial<ResolvedModelTarget>): ResolvedModelTarget => ({
  providerId: 'local',
  providerSource: 'deployment',
  presetId: 'openai-compatible',
  registryId: 'openai',
  baseUrl: 'https://llm.example.com/v1',
  customBaseUrl: true,
  modelId: 'llama3.3',
  ...overrides,
});

describe('a keyless OpenAI-compatible provider', () => {
  it('builds a language model without a key', async () => {
    const resolved = await languageModelFor(target({}));
    expect(resolved.model).toBeTruthy();
    expect(resolved).toMatchObject({ providerId: 'openai', modelId: 'llama3.3', apiKey: '' });
  });

  it('sends no Authorization header', async () => {
    const seen: Headers[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response('{"error":{"message":"stop here"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { model } = getModel({
      providerId: 'openai',
      modelId: 'llama3.3',
      apiKey: '',
      baseUrl: 'https://llm.example.com/v1',
      requiresApiKey: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalled();
    expect(seen[0].has('authorization')).toBe(false);
  });

  it('still sends a key when it has one', async () => {
    const seen: Headers[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response('{"error":{"message":"stop here"}}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { model } = getModel({
      providerId: 'openai',
      modelId: 'llama3.3',
      apiKey: 'sk-local',
      baseUrl: 'https://llm.example.com/v1',
      requiresApiKey: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
    expect(seen[0].get('authorization')).toBe('Bearer sk-local');
  });
});

describe('a provider that needs a key', () => {
  it('fails clearly for OpenAI without one', async () => {
    await expect(
      languageModelFor(
        target({
          presetId: 'openai',
          baseUrl: undefined,
          customBaseUrl: undefined,
          modelId: 'gpt-5.6',
        }),
      ),
    ).rejects.toThrow(/API key required for provider: openai/);
  });
});

describe('withoutEmptyBearer', () => {
  it('drops only an Authorization header without a credential', () => {
    expect(
      new Headers(withoutEmptyBearer({ headers: { Authorization: 'Bearer ' } })?.headers).has(
        'authorization',
      ),
    ).toBe(false);
    expect(
      new Headers(withoutEmptyBearer({ headers: { authorization: 'Bearer x' } })?.headers).get(
        'authorization',
      ),
    ).toBe('Bearer x');
    expect(withoutEmptyBearer(undefined)).toBeUndefined();
  });
});
