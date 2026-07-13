import { describe, expect, it, vi } from 'vitest';
import {
  applyTokenPlan,
  removeTokenPlan,
  type TokenPlanActions,
} from '@/lib/config/apply-token-plan';
import { TOKEN_PLAN_PRESETS, type TokenPlanPreset } from '@/lib/config/token-plan-presets';

function makeActions(): TokenPlanActions {
  return {
    setProviderConfig: vi.fn(),
    setImageProviderConfig: vi.fn(),
    setVideoProviderConfig: vi.fn(),
    setTTSProviderConfig: vi.fn(),
    setWebSearchProviderConfig: vi.fn(),
  };
}

const minimax = TOKEN_PLAN_PRESETS.find((p) => p.id === 'minimax')!;
// An LLM-only plan shape. The shipped presets are all multi-modal token plans
// now, so use a local fixture to exercise the "only touch declared modalities"
// path without coupling to a particular shipped entry.
const deepseek: TokenPlanPreset = {
  id: 'deepseek',
  name: 'DeepSeek',
  category: 'third_party',
  modalities: {
    llm: { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiFormat: 'openai' },
  },
};

describe('applyTokenPlan', () => {
  it('fills every declared modality for a full-set plan (MiniMax)', () => {
    const actions = makeActions();
    const results = applyTokenPlan(minimax, 'sk-test', actions);

    // LLM provider config: apiKey + baseUrl + type + custom name
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({
        apiKey: 'sk-test',
        baseUrl: 'https://api.minimaxi.com/anthropic/v1',
        type: 'anthropic',
        models: expect.arrayContaining([
          expect.objectContaining({
            id: 'MiniMax-M3',
            contextWindow: 1000000,
            capabilities: expect.objectContaining({ vision: true }),
          }),
        ]),
      }),
    );
    expect(actions.setImageProviderConfig).toHaveBeenCalledWith(
      'minimax-image',
      expect.objectContaining({ apiKey: 'sk-test', enabled: true, replaceBuiltInModels: true }),
    );
    expect(actions.setVideoProviderConfig).toHaveBeenCalledWith(
      'minimax-video',
      expect.objectContaining({ apiKey: 'sk-test', enabled: true, replaceBuiltInModels: true }),
    );
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith(
      'minimax-tts',
      expect.objectContaining({ apiKey: 'sk-test', enabled: true, modelId: 'speech-2.8-hd' }),
    );
    expect(actions.setWebSearchProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({ apiKey: 'sk-test', enabled: true }),
    );

    // Result reports each declared modality as lit, and includes llm.
    const lit = results.filter((r) => r.status === 'lit').map((r) => r.modality);
    expect(lit).toEqual(expect.arrayContaining(['llm', 'image', 'video', 'tts', 'webSearch']));
  });

  it('only touches declared modalities for an LLM-only plan (DeepSeek)', () => {
    const actions = makeActions();
    const results = applyTokenPlan(deepseek, 'sk-ds', actions);

    expect(actions.setProviderConfig).toHaveBeenCalledTimes(1);
    expect(actions.setImageProviderConfig).not.toHaveBeenCalled();
    expect(actions.setVideoProviderConfig).not.toHaveBeenCalled();
    expect(actions.setTTSProviderConfig).not.toHaveBeenCalled();
    expect(actions.setWebSearchProviderConfig).not.toHaveBeenCalled();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ modality: 'llm', status: 'lit' });
  });

  it('passes modelsUrl through to the LLM provider config when present', () => {
    const actions = makeActions();
    const preset = {
      ...deepseek,
      modalities: {
        llm: {
          providerId: 'x',
          baseUrl: 'https://x.com/v1',
          apiFormat: 'openai' as const,
          modelsUrl: 'https://x.com/custom/models',
        },
      },
    };
    applyTokenPlan(preset, 'k', actions);
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'x',
      expect.objectContaining({ modelsUrl: 'https://x.com/custom/models' }),
    );
  });

  it('seeds defaultModels into the LLM provider config when present', () => {
    const actions = makeActions();
    const preset = {
      ...deepseek,
      modalities: {
        llm: {
          providerId: 'x',
          baseUrl: 'https://x.com/api/plan/v1',
          apiFormat: 'anthropic' as const,
          defaultModels: ['ark-code-latest', 'kimi-k2.5'],
        },
      },
    };
    applyTokenPlan(preset, 'k', actions);
    const cfg = (actions.setProviderConfig as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      models: Array<{ id: string }>;
    };
    expect(cfg.models.map((m) => m.id)).toEqual(['ark-code-latest', 'kimi-k2.5']);
  });

  it('enriches seeded models with their built-in thinking capability', () => {
    const actions = makeActions();
    const preset = {
      ...deepseek,
      modalities: {
        llm: {
          providerId: 'doubao',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
          apiFormat: 'openai' as const,
          // dotted plan alias of a native Doubao Seed 2.0 model + a cross-vendor
          // model the Ark plan serves through its OpenAI-compatible endpoint
          defaultModels: ['doubao-seed-2.0-pro', 'deepseek-v4-pro'],
        },
      },
    };
    applyTokenPlan(preset, 'k', actions);
    const cfg = (actions.setProviderConfig as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      models: Array<{ id: string; capabilities?: { thinking?: unknown } }>;
    };
    // Both keep thinking support instead of silently dropping it.
    expect(cfg.models[0].capabilities?.thinking).toBeDefined();
    expect(cfg.models[1].capabilities?.thinking).toBeDefined();
  });

  it('preserves GPT-5.6 Sol catalog metadata when a plan uses the explicit model ID', () => {
    const actions = makeActions();
    const preset: TokenPlanPreset = {
      ...deepseek,
      modalities: {
        llm: {
          providerId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiFormat: 'openai',
          defaultModels: ['gpt-5.6-sol'],
        },
      },
    };

    applyTokenPlan(preset, 'sk-test', actions);
    const config = (actions.setProviderConfig as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      models: Array<{
        id: string;
        contextWindow?: number;
        outputWindow?: number;
        capabilities?: { vision?: boolean; thinking?: unknown };
      }>;
    };

    expect(config.models[0]).toMatchObject({
      id: 'gpt-5.6-sol',
      contextWindow: 1050000,
      outputWindow: 128000,
      capabilities: { vision: true },
    });
    expect(config.models[0].capabilities?.thinking).toBeDefined();
  });

  it('isolates a failing modality without aborting the rest', () => {
    const actions = makeActions();
    (actions.setImageProviderConfig as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('boom');
    });
    const results = applyTokenPlan(minimax, 'sk', actions);

    const image = results.find((r) => r.modality === 'image');
    expect(image?.status).toBe('failed');
    // Other modalities still lit
    expect(results.find((r) => r.modality === 'llm')?.status).toBe('lit');
    expect(results.find((r) => r.modality === 'tts')?.status).toBe('lit');
  });
});

describe('removeTokenPlan', () => {
  it('restores the built-in LLM provider + disables every declared modality (MiniMax)', () => {
    const actions = makeActions();
    removeTokenPlan(minimax, actions);

    // Built-in LLM provider: restored to its registry defaults (not just key
    // cleared), so it no longer points at the plan endpoint / plan model ids.
    expect(actions.setProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({
        apiKey: '',
        baseUrl: '',
        isBuiltIn: true,
        modelsUrl: undefined,
      }),
    );
    expect(actions.setImageProviderConfig).toHaveBeenCalledWith(
      'minimax-image',
      expect.objectContaining({
        apiKey: '',
        baseUrl: '',
        enabled: false,
        customModels: [],
        replaceBuiltInModels: false,
      }),
    );
    expect(actions.setVideoProviderConfig).toHaveBeenCalledWith(
      'minimax-video',
      expect.objectContaining({
        apiKey: '',
        baseUrl: '',
        enabled: false,
        customModels: [],
        replaceBuiltInModels: false,
      }),
    );
    expect(actions.setTTSProviderConfig).toHaveBeenCalledWith(
      'minimax-tts',
      expect.objectContaining({ apiKey: '', baseUrl: '', enabled: false }),
    );
    expect(actions.setWebSearchProviderConfig).toHaveBeenCalledWith(
      'minimax',
      expect.objectContaining({ apiKey: '', baseUrl: '', enabled: false }),
    );
  });

  it('falls back to clearing only the key for a non-built-in LLM provider', () => {
    const actions = makeActions();
    const custom: TokenPlanPreset = {
      id: 'custom-plan',
      name: 'Custom',
      category: 'third_party',
      modalities: {
        llm: {
          providerId: 'not-a-real-provider',
          baseUrl: 'https://x.com/v1',
          apiFormat: 'openai',
        },
      },
    };
    removeTokenPlan(custom, actions);
    expect(actions.setProviderConfig).toHaveBeenCalledWith('not-a-real-provider', { apiKey: '' });
  });
});
