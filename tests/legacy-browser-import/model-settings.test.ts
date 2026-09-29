/** The one-way import of the model settings earlier builds kept in the browser. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildModelSettingsProposal,
  MODEL_SETTINGS_IMPORT_KEY,
  normalizeLegacyModelSettings,
  safeProviderId,
  saveModelSettingsProposal,
  type LegacyModelSettingsState,
} from '@/lib/legacy-browser-import/model-settings';

import { PROVIDERS } from '@/lib/ai/providers';

import { MemoryStorage } from './harness';

describe('buildModelSettingsProposal', () => {
  it('proposes nothing for a browser that never configured a model', () => {
    expect(buildModelSettingsProposal(undefined)).toBeUndefined();
    expect(
      buildModelSettingsProposal({
        providerId: 'openai',
        modelId: '',
        providersConfig: {
          openai: { apiKey: '', baseUrl: '', defaultBaseUrl: 'https://api.openai.com/v1' },
        },
        pdfProviderId: 'unpdf',
        pdfProvidersConfig: { unpdf: { apiKey: '', baseUrl: '', enabled: true } },
      }),
    ).toBeUndefined();
  });

  it('imports a built-in provider with a key and the chosen model as the llm root', () => {
    const proposal = buildModelSettingsProposal({
      providerId: 'openai',
      modelId: 'gpt-5',
      providersConfig: {
        openai: { apiKey: ' sk-openai ', baseUrl: '', defaultBaseUrl: 'https://api.openai.com/v1' },
        anthropic: {
          apiKey: '',
          baseUrl: 'https://proxy.example.com/v1',
          defaultBaseUrl: 'https://api.anthropic.com/v1',
        },
        google: { apiKey: '', baseUrl: '' },
      },
    });
    expect(proposal).toEqual({
      providers: {
        openai: { preset: 'openai', apiKey: 'sk-openai' },
        anthropic: { preset: 'anthropic', baseUrl: 'https://proxy.example.com/v1' },
      },
      slots: { llm: 'openai:gpt-5' },
    });
  });

  it('carries models the user added to a built-in provider', () => {
    const catalogue = PROVIDERS.openai.models.map((model) => model.id);
    const proposal = buildModelSettingsProposal({
      providerId: 'openai',
      modelId: 'ft:gpt-4o:my-org',
      providersConfig: {
        openai: {
          apiKey: 'sk-openai',
          baseUrl: '',
          models: [...catalogue.map((id) => ({ id })), { id: 'ft:gpt-4o:my-org' }],
        },
      },
    });
    // The catalogue stays listed: a provider's list names the models it serves.
    expect(proposal?.providers?.openai).toEqual({
      preset: 'openai',
      apiKey: 'sk-openai',
      models: [...catalogue, 'ft:gpt-4o:my-org'],
    });
    expect(proposal?.slots).toEqual({ llm: 'openai:ft:gpt-4o:my-org' });

    // Only catalogue models: nothing to list.
    expect(
      buildModelSettingsProposal({
        providersConfig: {
          openai: { apiKey: 'sk', baseUrl: '', models: catalogue.map((id) => ({ id })) },
        },
      })?.providers?.openai,
    ).toEqual({ preset: 'openai', apiKey: 'sk' });
  });

  it('does not count a base URL equal to the default as a custom endpoint', () => {
    expect(
      buildModelSettingsProposal({
        providersConfig: {
          openai: {
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1/',
            defaultBaseUrl: 'https://api.openai.com/v1',
          },
        },
      }),
    ).toBeUndefined();
  });

  it('imports a custom OpenAI-compatible provider with its endpoint and models', () => {
    const proposal = buildModelSettingsProposal({
      providerId: 'custom-1712345',
      modelId: 'my-model',
      providersConfig: {
        'custom-1712345': {
          apiKey: 'sk-custom',
          baseUrl: '',
          defaultBaseUrl: 'https://llm.example.com/v1',
          type: 'openai',
          isBuiltIn: false,
          models: [{ id: 'my-model' }, { id: 'other' }, { id: 'my-model' }],
        },
        // No endpoint: nothing to call.
        'custom-empty': { apiKey: 'sk', baseUrl: '', type: 'openai', isBuiltIn: false },
      },
    });
    expect(proposal).toEqual({
      providers: {
        'custom-1712345': {
          preset: 'openai-compatible',
          apiKey: 'sk-custom',
          baseUrl: 'https://llm.example.com/v1',
          models: ['my-model', 'other'],
        },
      },
      slots: { llm: 'custom-1712345:my-model' },
    });
  });

  it('derives safe unique provider ids', () => {
    expect(safeProviderId('Custom_Provider!')).toBe('custom-provider');
    expect(safeProviderId('--x')).toBe('x');
    expect(safeProviderId('***')).toBe('provider');
    expect(safeProviderId('a'.repeat(80))).toHaveLength(63);

    const proposal = buildModelSettingsProposal({
      providersConfig: {
        'custom-A': { baseUrl: 'https://a.example.com', type: 'openai', isBuiltIn: false },
        'custom-a': { baseUrl: 'https://b.example.com', type: 'openai', isBuiltIn: false },
      },
    });
    expect(Object.keys(proposal?.providers ?? {})).toEqual(['custom-a', 'custom-a-2']);
  });

  it('names a server-configured chosen provider by its preset id and never imports its state', () => {
    expect(
      buildModelSettingsProposal({
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        providersConfig: {
          deepseek: { apiKey: 'stale', baseUrl: '', isServerConfigured: true },
        },
      }),
    ).toEqual({ slots: { llm: 'deepseek:deepseek-chat' } });
  });

  it('leaves the model out when its provider is switched off or has nothing to import', () => {
    expect(
      buildModelSettingsProposal({
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: 'sk', baseUrl: '', enabled: false } },
      }),
    ).toEqual({ providers: { openai: { preset: 'openai', apiKey: 'sk' } } });
    expect(
      buildModelSettingsProposal({
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: '', baseUrl: '' } },
      }),
    ).toBeUndefined();
  });

  it('imports an enrolled token plan as one provider covering its services', () => {
    const planKey = 'sk-plan';
    const proposal = buildModelSettingsProposal({
      providerId: 'minimax',
      modelId: 'MiniMax-M3',
      tokenPlanEnrollments: { minimax: 'minimax' },
      providersConfig: {
        minimax: { apiKey: planKey, baseUrl: 'https://api.minimaxi.com/anthropic/v1' },
      },
      ttsEnabled: true,
      ttsProviderId: 'minimax-tts',
      ttsProvidersConfig: {
        'minimax-tts': {
          apiKey: planKey,
          baseUrl: 'https://api.minimaxi.com',
          modelId: 'speech-2.8-turbo',
        },
      },
      imageGenerationEnabled: true,
      imageProviderId: 'minimax-image',
      imageModelId: 'image-01',
      imageProvidersConfig: {
        'minimax-image': { apiKey: planKey, baseUrl: 'https://api.minimaxi.com' },
      },
    });
    expect(proposal).toEqual({
      providers: { minimax: { preset: 'minimax', apiKey: planKey } },
      slots: {
        llm: 'minimax:MiniMax-M3',
        tts: 'minimax:speech-2.8-turbo',
        image: 'minimax:image-01',
      },
    });
  });

  it('treats a key on a plan provider without enrollment as a personal key', () => {
    expect(
      buildModelSettingsProposal({
        providersConfig: { tokendance: { apiKey: 'sk-own', baseUrl: '' } },
      }),
    ).toEqual({ providers: { tokendance: { preset: 'tokendance', apiKey: 'sk-own' } } });
  });

  it('imports keyed services and the enabled selections as media roots', () => {
    const state: LegacyModelSettingsState = {
      ttsEnabled: true,
      ttsProviderId: 'openai-tts',
      ttsProvidersConfig: {
        'openai-tts': { apiKey: 'sk-tts', baseUrl: '', modelId: 'gpt-4o-mini-tts' },
        'custom-tts-1': { apiKey: 'sk-custom', baseUrl: 'https://tts.example.com' },
      },
      asrEnabled: true,
      asrProviderId: 'qwen-asr',
      asrProvidersConfig: { 'qwen-asr': { apiKey: 'sk-asr', baseUrl: '' } },
      imageGenerationEnabled: false,
      imageProviderId: 'seedream',
      imageModelId: 'doubao-seedream-5-0-260128',
      imageProvidersConfig: { seedream: { apiKey: 'sk-img', baseUrl: '' } },
      videoGenerationEnabled: true,
      videoProviderId: 'kling',
      videoModelId: 'kling-v2',
      videoProvidersConfig: { kling: { apiKey: 'sk-video', baseUrl: '' } },
      webSearchEnabled: true,
      webSearchProviderId: 'minimax',
      webSearchProvidersConfig: {
        minimax: { apiKey: 'sk-search', baseUrl: 'https://api.minimaxi.com' },
        claude: { apiKey: 'sk-claude', baseUrl: '', modelId: 'claude-sonnet-5' },
      },
      pdfProviderId: 'mineru-cloud',
      pdfProvidersConfig: {
        'mineru-cloud': { apiKey: 'sk-doc', baseUrl: '' },
        alidocmind: { apiKey: '', baseUrl: '', accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
    };
    expect(buildModelSettingsProposal(state)).toEqual({
      providers: {
        'openai-tts': { preset: 'openai-tts', apiKey: 'sk-tts' },
        'qwen-asr': { preset: 'qwen-asr', apiKey: 'sk-asr' },
        seedream: { preset: 'seedream', apiKey: 'sk-img' },
        kling: { preset: 'kling', apiKey: 'sk-video' },
        'minimax-search': { preset: 'minimax-search', apiKey: 'sk-search' },
        claude: { preset: 'claude', apiKey: 'sk-claude' },
        'mineru-cloud': { preset: 'mineru-cloud', apiKey: 'sk-doc' },
      },
      slots: {
        tts: 'openai-tts:gpt-4o-mini-tts',
        asr: 'qwen-asr',
        // Image generation was switched off: the provider comes, the slot does not.
        video: 'kling:kling-v2',
        webSearch: 'minimax-search',
        document: 'mineru-cloud',
      },
    });
  });

  it('keeps an explicit browser speech choice', () => {
    expect(
      buildModelSettingsProposal({
        ttsEnabled: true,
        ttsProviderId: 'browser-native-tts',
        asrEnabled: true,
        asrProviderId: 'browser-native',
      }),
    ).toEqual({
      providers: {
        'browser-native-tts': { preset: 'browser-native-tts' },
        'browser-native': { preset: 'browser-native' },
      },
      slots: { tts: 'browser-native-tts', asr: 'browser-native' },
    });
  });

  it('does not import per-stage routes', () => {
    const state = {
      providerId: 'openai',
      modelId: 'gpt-5',
      providersConfig: { openai: { apiKey: 'sk', baseUrl: '' } },
      llmStageRoutes: {
        'scene-content:slide': { providerId: 'openai', modelId: 'gpt-5-mini' },
      },
    } as LegacyModelSettingsState;
    const proposal = buildModelSettingsProposal(state);
    expect(proposal?.slots).toEqual({ llm: 'openai:gpt-5' });
    expect(JSON.stringify(proposal)).not.toContain('gpt-5-mini');
  });

  it('proposes speech input off only when the user turned it off', () => {
    // Without an asr slot the browser's own recognition would take over.
    expect(buildModelSettingsProposal({ asrEnabled: false })).toEqual({ slots: { asr: null } });
    expect(buildModelSettingsProposal({})).toBeUndefined();
    expect(buildModelSettingsProposal({ asrEnabled: true })).toBeUndefined();
  });

  it('carries no other off switch over: availability follows the slots', () => {
    expect(
      buildModelSettingsProposal({
        ttsEnabled: false,
        imageGenerationEnabled: false,
        videoGenerationEnabled: false,
        webSearchEnabled: false,
      }),
    ).toBeUndefined();
    expect(
      buildModelSettingsProposal({
        ttsEnabled: false,
        webSearchEnabled: false,
        asrEnabled: false,
        providersConfig: { openai: { apiKey: 'sk', baseUrl: '' } },
      }),
    ).toEqual({ providers: { openai: { preset: 'openai', apiKey: 'sk' } }, slots: { asr: null } });
  });

  it('names a selected server-configured media provider by its preset id', () => {
    expect(
      buildModelSettingsProposal({
        ttsEnabled: true,
        ttsProviderId: 'minimax-tts',
        ttsProvidersConfig: {
          'minimax-tts': {
            apiKey: 'stale',
            baseUrl: '',
            isServerConfigured: true,
            modelId: 'speech-2.8-hd',
          },
        },
        webSearchEnabled: true,
        webSearchProviderId: 'minimax',
        webSearchProvidersConfig: {
          minimax: { apiKey: '', baseUrl: '', isServerConfigured: true },
        },
        imageGenerationEnabled: true,
        imageProviderId: 'seedream',
        imageModelId: 'seedream-5',
        imageProvidersConfig: { seedream: { apiKey: '', baseUrl: '', isServerConfigured: true } },
      }),
    ).toEqual({
      slots: {
        tts: 'minimax-tts:speech-2.8-hd',
        image: 'seedream:seedream-5',
        webSearch: 'minimax-search',
      },
    });
  });
});

describe('normalizeLegacyModelSettings', () => {
  it('clears the version 0 default model', () => {
    const state = normalizeLegacyModelSettings(
      {
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        providersConfig: { openai: { apiKey: 'sk' } },
      },
      0,
    );
    expect(state.modelId).toBe('');
    expect(buildModelSettingsProposal(state)?.slots).toBeUndefined();
    // Only version 0 carried that default.
    expect(
      normalizeLegacyModelSettings({ providerId: 'openai', modelId: 'gpt-4o-mini' }, 1).modelId,
    ).toBe('gpt-4o-mini');
  });

  it('turns the single TTS model setting into a provider selection', () => {
    expect(normalizeLegacyModelSettings({ ttsModel: 'azure-tts' }, 1).ttsProviderId).toBe(
      'azure-tts',
    );
    expect(normalizeLegacyModelSettings({ ttsModel: 'other' }, 1).ttsProviderId).toBe('openai-tts');
  });

  it('moves global TTS and ASR model ids onto the selected providers', () => {
    const state = normalizeLegacyModelSettings(
      {
        ttsProviderId: 'openai-tts',
        ttsModelId: 'tts-1-hd',
        ttsProvidersConfig: { 'openai-tts': { apiKey: 'sk-tts' } },
        asrProviderId: 'qwen-asr',
        asrModelId: 'qwen3-asr',
        asrProvidersConfig: { 'qwen-asr': { apiKey: 'sk-asr' } },
        ttsEnabled: true,
      },
      1,
    );
    expect(state.ttsProvidersConfig?.['openai-tts']?.modelId).toBe('tts-1-hd');
    expect(state.asrProvidersConfig?.['qwen-asr']?.modelId).toBe('qwen3-asr');
    expect(state).not.toHaveProperty('ttsModelId');
    expect(buildModelSettingsProposal(state)?.slots).toMatchObject({
      tts: 'openai-tts:tts-1-hd',
      asr: 'qwen-asr:qwen3-asr',
    });
  });

  it("renames a TTS provider's model field", () => {
    const state = normalizeLegacyModelSettings(
      { ttsProvidersConfig: { 'minimax-tts': { apiKey: 'k', model: 'speech-2.8-hd' } } },
      2,
    );
    expect(state.ttsProvidersConfig?.['minimax-tts']).toEqual({
      apiKey: 'k',
      modelId: 'speech-2.8-hd',
    });
  });

  it("moves the flat web search key to Tavily's entry", () => {
    const state = normalizeLegacyModelSettings(
      { webSearchApiKey: 'tvly-key', webSearchEnabled: true },
      1,
    );
    expect(state.webSearchProvidersConfig).toMatchObject({ tavily: { apiKey: 'tvly-key' } });
    expect(buildModelSettingsProposal(state)).toEqual({
      providers: { tavily: { preset: 'tavily', apiKey: 'tvly-key' } },
      slots: { webSearch: 'tavily' },
    });
  });

  it('does not change the stored object', () => {
    const persisted = {
      ttsModelId: 'x',
      ttsProviderId: 'openai-tts',
      ttsProvidersConfig: { 'openai-tts': {} },
    };
    normalizeLegacyModelSettings(persisted, 1);
    expect(persisted).toEqual({
      ttsModelId: 'x',
      ttsProviderId: 'openai-tts',
      ttsProvidersConfig: { 'openai-tts': {} },
    });
  });
});

describe('saveModelSettingsProposal', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it('reports failure when the proposal cannot be written, without quoting it', () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw Object.assign(new Error('quota exceeded while writing sk-secret-value'), {
        name: 'QuotaExceededError',
      });
    };
    expect(
      saveModelSettingsProposal(
        { providers: { a: { preset: 'openai', apiKey: 'sk-secret-value' } } },
        storage,
      ),
    ).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-secret-value');
    expect(JSON.stringify(warn.mock.calls)).toContain('QuotaExceededError');
  });

  it('reports failure over an unreadable proposal already waiting, without quoting it', () => {
    const storage = new MemoryStorage();
    storage.setItem(MODEL_SETTINGS_IMPORT_KEY, '{"providers":{"a":{"apiKey":"sk-old-secret"');
    expect(saveModelSettingsProposal({ slots: { llm: 'a:m' } }, storage)).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-old-secret');
  });

  it('reports success when there is nothing to keep', () => {
    expect(saveModelSettingsProposal(undefined, new MemoryStorage())).toBe(true);
  });

  it('keeps the proposal under its own key and merges one already waiting', () => {
    const storage = new MemoryStorage();
    saveModelSettingsProposal(undefined, storage);
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();

    expect(
      saveModelSettingsProposal({ providers: { a: { preset: 'openai', apiKey: 'k1' } } }, storage),
    ).toBe(true);
    expect(saveModelSettingsProposal({ slots: { llm: 'a:m' } }, storage)).toBe(true);
    expect(JSON.parse(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)!)).toEqual({
      providers: { a: { preset: 'openai', apiKey: 'k1' } },
      slots: { llm: 'a:m' },
    });
  });
});
