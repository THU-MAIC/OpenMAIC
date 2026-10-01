import { vi } from 'vitest';
import type { NextRequest } from 'next/server';

import type { StepLanguageModel, StepLogger } from '@/lib/server/generation/steps/context';

/** A resolved model whose calls the test's mocked callLLM / streamLLM answer. */
export function fakeModel(overrides: Partial<StepLanguageModel> = {}): StepLanguageModel {
  return {
    model: {
      provider: 'test.chat',
      modelId: 'test-model',
    } as unknown as StepLanguageModel['model'],
    modelInfo: { outputWindow: 4096, capabilities: {} } as StepLanguageModel['modelInfo'],
    modelString: 'test:test-model',
    thinkingConfig: undefined,
    serverManaged: false,
    ...overrides,
  };
}

export function testLogger(): StepLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

export function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** Drop the values a generation mints afresh on every run (ids, timestamps). */
export function withoutMintedValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMintedValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['id', 'createdAt', 'updatedAt'].includes(key))
      .map(([key, entry]) => [key, withoutMintedValues(entry)]),
  );
}
