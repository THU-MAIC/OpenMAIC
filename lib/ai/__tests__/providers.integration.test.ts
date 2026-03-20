/**
 * Integration tests for MiniMax provider — validates that getModel()
 * creates a valid LanguageModel instance via the Anthropic SDK adapter.
 *
 * These tests do NOT make real API calls; they verify that the provider
 * configuration integrates correctly with the Vercel AI SDK factory
 * functions and that the resulting model object has the expected shape.
 */

import { describe, it, expect } from 'vitest';
import { getModel, PROVIDERS } from '../providers';

describe('MiniMax getModel() integration', () => {
  it('should create a model instance for MiniMax-M2.7', () => {
    const { model, modelInfo } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
      apiKey: 'test-key-not-used',
    });

    expect(model).toBeDefined();
    expect(model.modelId).toBe('MiniMax-M2.7');
    expect(modelInfo).toBeDefined();
    expect(modelInfo!.name).toBe('MiniMax M2.7');
  });

  it('should create a model instance for MiniMax-M2.5-highspeed', () => {
    const { model, modelInfo } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.5-highspeed',
      apiKey: 'test-key-not-used',
    });

    expect(model).toBeDefined();
    expect(model.modelId).toBe('MiniMax-M2.5-highspeed');
    expect(modelInfo).toBeDefined();
    expect(modelInfo!.name).toBe('MiniMax M2.5 Highspeed');
  });

  it('should create a model instance for MiniMax-M2.5', () => {
    const { model, modelInfo } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.5',
      apiKey: 'test-key-not-used',
    });

    expect(model).toBeDefined();
    expect(model.modelId).toBe('MiniMax-M2.5');
    expect(modelInfo).toBeDefined();
  });

  it('should throw when API key is missing', () => {
    expect(() =>
      getModel({
        providerId: 'minimax',
        modelId: 'MiniMax-M2.7',
        apiKey: '',
      }),
    ).toThrow('API key required for provider: minimax');
  });

  it('should use the provider default base URL', () => {
    const provider = PROVIDERS.minimax;
    expect(provider.defaultBaseUrl).toBe(
      'https://api.minimaxi.com/anthropic/v1',
    );

    // The model is created with the provider's default base URL
    const { model } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
      apiKey: 'test-key-not-used',
    });
    expect(model).toBeDefined();
  });

  it('should allow overriding the base URL', () => {
    const { model } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
      apiKey: 'test-key-not-used',
      baseUrl: 'https://custom-proxy.example.com/v1',
    });
    expect(model).toBeDefined();
  });

  it('should use anthropic provider type for model creation', () => {
    // Verify the provider type is 'anthropic' which routes through createAnthropic()
    expect(PROVIDERS.minimax.type).toBe('anthropic');

    // The model should be created successfully via the anthropic code path
    const { model } = getModel({
      providerId: 'minimax',
      modelId: 'MiniMax-M2.7',
      apiKey: 'test-key-not-used',
    });
    expect(model).toBeDefined();
    expect(model.provider).toContain('anthropic');
  });
});
