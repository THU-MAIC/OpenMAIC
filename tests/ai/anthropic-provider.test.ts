import { describe, expect, it } from 'vitest';

import { getProvider } from '@/lib/ai/providers';

describe('Anthropic provider defaults', () => {
  it('lists Claude Fable 5 first with current token windows', () => {
    const models = getProvider('anthropic')?.models ?? [];
    const [latest] = models;

    expect(latest).toMatchObject({
      id: 'claude-fable-5',
      name: 'Claude Fable 5',
      contextWindow: 1000000,
      outputWindow: 128000,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
  });

  it('keeps Claude Opus 4.8 in the catalog with current token windows', () => {
    const models = getProvider('anthropic')?.models ?? [];
    const opus = models.find((m) => m.id === 'claude-opus-4-8');

    expect(opus).toMatchObject({
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      contextWindow: 1000000,
      outputWindow: 128000,
      capabilities: {
        streaming: true,
        tools: true,
        vision: true,
      },
    });
  });
});
