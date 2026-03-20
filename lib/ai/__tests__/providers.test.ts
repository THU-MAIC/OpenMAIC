/**
 * Unit tests for AI providers configuration — MiniMax provider
 */

import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  getProvider,
  getModelInfo,
  parseModelString,
  getAllModels,
} from '../providers';

describe('MiniMax provider configuration', () => {
  it('should be registered as a built-in provider', () => {
    expect(PROVIDERS.minimax).toBeDefined();
    expect(PROVIDERS.minimax.id).toBe('minimax');
    expect(PROVIDERS.minimax.name).toBe('MiniMax');
  });

  it('should use the Anthropic-compatible API type', () => {
    expect(PROVIDERS.minimax.type).toBe('anthropic');
  });

  it('should have a valid default base URL', () => {
    expect(PROVIDERS.minimax.defaultBaseUrl).toBe(
      'https://api.minimaxi.com/anthropic/v1',
    );
  });

  it('should require an API key', () => {
    expect(PROVIDERS.minimax.requiresApiKey).toBe(true);
  });

  it('should have an icon path', () => {
    expect(PROVIDERS.minimax.icon).toBe('/logos/minimax.svg');
  });

  it('should include MiniMax-M2.7 as the flagship model', () => {
    const m27 = PROVIDERS.minimax.models.find(
      (m) => m.id === 'MiniMax-M2.7',
    );
    expect(m27).toBeDefined();
    expect(m27!.name).toBe('MiniMax M2.7');
    expect(m27!.contextWindow).toBe(204800);
    expect(m27!.outputWindow).toBe(8192);
  });

  it('should list MiniMax-M2.7 as the first (top) model', () => {
    expect(PROVIDERS.minimax.models[0].id).toBe('MiniMax-M2.7');
  });

  it('should include MiniMax-M2.5', () => {
    const m25 = PROVIDERS.minimax.models.find(
      (m) => m.id === 'MiniMax-M2.5',
    );
    expect(m25).toBeDefined();
    expect(m25!.name).toBe('MiniMax M2.5');
  });

  it('should include MiniMax-M2.5-highspeed', () => {
    const m25hs = PROVIDERS.minimax.models.find(
      (m) => m.id === 'MiniMax-M2.5-highspeed',
    );
    expect(m25hs).toBeDefined();
    expect(m25hs!.name).toBe('MiniMax M2.5 Highspeed');
    expect(m25hs!.contextWindow).toBe(204800);
  });

  it('should include legacy models (M2.1, M2.1-lightning, M2)', () => {
    const m21 = PROVIDERS.minimax.models.find(
      (m) => m.id === 'MiniMax-M2.1',
    );
    const m21l = PROVIDERS.minimax.models.find(
      (m) => m.id === 'MiniMax-M2.1-lightning',
    );
    const m2 = PROVIDERS.minimax.models.find((m) => m.id === 'MiniMax-M2');
    expect(m21).toBeDefined();
    expect(m21l).toBeDefined();
    expect(m2).toBeDefined();
  });

  it('should have 6 models in total', () => {
    expect(PROVIDERS.minimax.models).toHaveLength(6);
  });

  it('all models should support streaming and tools', () => {
    for (const model of PROVIDERS.minimax.models) {
      expect(model.capabilities?.streaming).toBe(true);
      expect(model.capabilities?.tools).toBe(true);
    }
  });

  it('no models should claim vision support', () => {
    for (const model of PROVIDERS.minimax.models) {
      expect(model.capabilities?.vision).toBe(false);
    }
  });
});

describe('getProvider() for MiniMax', () => {
  it('should return the MiniMax provider', () => {
    const provider = getProvider('minimax');
    expect(provider).toBeDefined();
    expect(provider!.id).toBe('minimax');
  });
});

describe('getModelInfo() for MiniMax models', () => {
  it('should return info for MiniMax-M2.7', () => {
    const info = getModelInfo('minimax', 'MiniMax-M2.7');
    expect(info).toBeDefined();
    expect(info!.name).toBe('MiniMax M2.7');
  });

  it('should return info for MiniMax-M2.5-highspeed', () => {
    const info = getModelInfo('minimax', 'MiniMax-M2.5-highspeed');
    expect(info).toBeDefined();
    expect(info!.name).toBe('MiniMax M2.5 Highspeed');
  });

  it('should return undefined for unknown model', () => {
    const info = getModelInfo('minimax', 'MiniMax-M99');
    expect(info).toBeUndefined();
  });
});

describe('parseModelString() with MiniMax', () => {
  it('should parse "minimax:MiniMax-M2.7"', () => {
    const result = parseModelString('minimax:MiniMax-M2.7');
    expect(result.providerId).toBe('minimax');
    expect(result.modelId).toBe('MiniMax-M2.7');
  });

  it('should parse "minimax:MiniMax-M2.5-highspeed"', () => {
    const result = parseModelString('minimax:MiniMax-M2.5-highspeed');
    expect(result.providerId).toBe('minimax');
    expect(result.modelId).toBe('MiniMax-M2.5-highspeed');
  });
});

describe('getAllModels() includes MiniMax', () => {
  it('should include MiniMax in the grouped results', () => {
    const all = getAllModels();
    const minimaxGroup = all.find((g) => g.provider.id === 'minimax');
    expect(minimaxGroup).toBeDefined();
    expect(minimaxGroup!.models.length).toBeGreaterThanOrEqual(6);
  });
});

describe('MiniMax model ordering', () => {
  it('should list models from newest to oldest', () => {
    const ids = PROVIDERS.minimax.models.map((m) => m.id);
    expect(ids).toEqual([
      'MiniMax-M2.7',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-lightning',
      'MiniMax-M2',
    ]);
  });
});
