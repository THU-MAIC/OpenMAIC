import { describe, expect, it } from 'vitest';

import { finalizeProviderRequestUrl, getProvider, resolveProviderBaseUrl } from '@/lib/ai/providers';

describe('MiniMax provider defaults', () => {
  it('uses the Anthropic-compatible v1 endpoint by default', () => {
    expect(getProvider('minimax')?.defaultBaseUrl).toBe('https://api.minimaxi.com/anthropic/v1');
  });

  it('matches the official Anthropic-compatible MiniMax model list', () => {
    const modelIds = getProvider('minimax')?.models.map((model) => model.id) ?? [];
    expect(modelIds).toEqual([
      'MiniMax-M2',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
    ]);
  });

  it('normalizes custom MiniMax endpoints to the Anthropic-compatible v1 path', () => {
    expect(resolveProviderBaseUrl('minimax', 'MiniMax-M2.5', 'https://proxy.example.com')).toBe(
      'https://proxy.example.com/anthropic/v1',
    );
  });
});

describe('OpenAI-compatible base URL templates', () => {
  it('replaces {{model}} in the configured base URL', () => {
    expect(
      resolveProviderBaseUrl(
        'custom-azure-foundry',
        'gpt-5.4',
        'https://resource.example.com/openai/deployments/{{model}}',
      ),
    ).toBe('https://resource.example.com/openai/deployments/gpt-5.4');
  });

  it('URL-encodes model ids inserted into path templates', () => {
    expect(
      resolveProviderBaseUrl(
        'custom-openai-compatible',
        'publisher/model-name',
        'https://gateway.example.com/deployments/{{model}}',
      ),
    ).toBe('https://gateway.example.com/deployments/publisher%2Fmodel-name');
  });

  it('appends the Azure OpenAI api-version to deployment endpoints', () => {
    expect(
      finalizeProviderRequestUrl(
        'https://resource.example.cognitiveservices.azure.com/openai/deployments/gpt-5.4/chat/completions',
      ),
    ).toBe(
      'https://resource.example.cognitiveservices.azure.com/openai/deployments/gpt-5.4/chat/completions?api-version=2024-05-01-preview',
    );
  });

  it('preserves an explicit Azure OpenAI api-version if already present', () => {
    expect(
      finalizeProviderRequestUrl(
        'https://resource.example.openai.azure.com/openai/deployments/gpt-5.4/chat/completions?api-version=2024-10-21',
      ),
    ).toBe(
      'https://resource.example.openai.azure.com/openai/deployments/gpt-5.4/chat/completions?api-version=2024-10-21',
    );
  });
});
