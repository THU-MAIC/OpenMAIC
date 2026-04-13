import { describe, expect, it } from 'vitest';
import {
  createCustomProviderSettings,
  createVerifyModelRequest,
} from '@/components/settings/utils';

describe('custom provider baseUrl persistence', () => {
  it('stores the entered baseUrl on custom provider creation', () => {
    const providerConfig = createCustomProviderSettings({
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'https://example.com/v1',
      icon: '',
      requiresApiKey: true,
    });

    expect(providerConfig.baseUrl).toBe('https://example.com/v1');
    expect(providerConfig.defaultBaseUrl).toBe('https://example.com/v1');
  });

  it('builds verify-model requests with the persisted baseUrl', () => {
    const providerConfig = createCustomProviderSettings({
      name: 'Test Provider',
      type: 'openai',
      baseUrl: 'https://example.com/v1',
      icon: '',
      requiresApiKey: true,
    });

    const request = createVerifyModelRequest({
      providerId: 'custom-123',
      modelId: 'test-model',
      apiKey: 'sk-test',
      baseUrl: providerConfig.baseUrl,
      providerType: providerConfig.type,
      requiresApiKey: providerConfig.requiresApiKey,
    });

    expect(request.baseUrl).toBe('https://example.com/v1');
    expect(request.model).toBe('custom-123:test-model');
    expect(request.providerType).toBe('openai');
  });
});
