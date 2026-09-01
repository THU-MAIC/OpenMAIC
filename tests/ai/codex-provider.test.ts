import { describe, expect, it } from 'vitest';
import { getModelInfo, getProvider } from '@/lib/ai/providers';

describe('Codex subscription provider catalog', () => {
  it('is a keyless server transport with conservative tool capabilities', () => {
    expect(getProvider('codex')).toMatchObject({
      id: 'codex',
      type: 'codex',
      requiresApiKey: false,
      supportsModelDiscovery: false,
    });
    expect(getModelInfo('codex', 'gpt-5.6-sol')).toMatchObject({
      capabilities: {
        streaming: true,
        tools: false,
        vision: true,
      },
    });
  });
});
