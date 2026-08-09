import { describe, expect, it } from 'vitest';

import { getProvider } from '@/lib/ai/providers';

describe('Anthropic provider defaults', () => {
  it('lists the latest Claude 5 models first with current token windows', () => {
    const models = getProvider('anthropic')?.models ?? [];

    expect(models.slice(0, 3)).toMatchObject([
      {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        contextWindow: 1000000,
        outputWindow: 128000,
      },
      {
        id: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        contextWindow: 1000000,
        outputWindow: 128000,
      },
      {
        id: 'claude-fable-5',
        name: 'Claude Fable 5',
        contextWindow: 1000000,
        outputWindow: 128000,
      },
    ]);
    for (const model of models.slice(0, 3)) {
      expect(model.capabilities).toMatchObject({
        streaming: true,
        tools: true,
        vision: true,
      });
    }
    expect(models[2]?.capabilities?.thinking).toMatchObject({
      toggleable: false,
      budgetAdjustable: false,
      defaultEnabled: true,
    });
  });
});
