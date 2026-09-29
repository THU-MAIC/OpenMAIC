/** The one-way import of the model settings earlier builds kept in the browser. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildModelSettingsProposal,
  MODEL_SETTINGS_IMPORT_ENDPOINT,
  MODEL_SETTINGS_IMPORT_KEY,
  runModelSettingsImport,
  safeProviderId,
  saveModelSettingsProposal,
  type LegacyModelSettingsState,
} from '@/lib/legacy-browser-import/model-settings';

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
        asrEnabled: false,
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
      asrEnabled: false,
    });
    expect(proposal).toEqual({
      providers: {
        openai: { preset: 'openai', apiKey: 'sk-openai' },
        anthropic: { preset: 'anthropic', baseUrl: 'https://proxy.example.com/v1' },
      },
      slots: { llm: 'openai:gpt-5' },
    });
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
        asrEnabled: false,
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
      asrEnabled: false,
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
      asrEnabled: false,
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
        asrEnabled: false,
      }),
    ).toEqual({ slots: { llm: 'deepseek:deepseek-chat' } });
  });

  it('leaves the model out when its provider is switched off or has nothing to import', () => {
    expect(
      buildModelSettingsProposal({
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: 'sk', baseUrl: '', enabled: false } },
        asrEnabled: false,
      }),
    ).toEqual({ providers: { openai: { preset: 'openai', apiKey: 'sk' } } });
    expect(
      buildModelSettingsProposal({
        providerId: 'openai',
        modelId: 'gpt-5',
        providersConfig: { openai: { apiKey: '', baseUrl: '' } },
        asrEnabled: false,
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
      asrEnabled: false,
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
        asrEnabled: false,
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
      asrEnabled: false,
    } as LegacyModelSettingsState;
    const proposal = buildModelSettingsProposal(state);
    expect(proposal?.slots).toEqual({ llm: 'openai:gpt-5' });
    expect(JSON.stringify(proposal)).not.toContain('gpt-5-mini');
  });
});

describe('saveModelSettingsProposal', () => {
  it('keeps the proposal under its own key and merges one already waiting', () => {
    const storage = new MemoryStorage();
    saveModelSettingsProposal(undefined, storage);
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();

    saveModelSettingsProposal({ providers: { a: { preset: 'openai', apiKey: 'k1' } } }, storage);
    saveModelSettingsProposal({ slots: { llm: 'a:m' } }, storage);
    expect(JSON.parse(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)!)).toEqual({
      providers: { a: { preset: 'openai', apiKey: 'k1' } },
      slots: { llm: 'a:m' },
    });
  });
});

describe('runModelSettingsImport', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  const waiting = () => {
    const storage = new MemoryStorage();
    storage.setItem(
      MODEL_SETTINGS_IMPORT_KEY,
      JSON.stringify({ providers: { openai: { preset: 'openai', apiKey: 'sk' } } }),
    );
    return storage;
  };

  it('does nothing when no proposal is waiting', async () => {
    const fetch = vi.fn();
    expect(await runModelSettingsImport({ fetch, storage: new MemoryStorage() })).toBe('none');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts the proposal and clears it from the browser on success', async () => {
    const storage = waiting();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            imported: [],
            skipped: [{ item: 'openai', reason: 'A provider with this id already exists' }],
          }),
          { status: 200 },
        ),
    );
    expect(await runModelSettingsImport({ fetch, storage })).toBe('imported');
    expect(fetch).toHaveBeenCalledWith(
      MODEL_SETTINGS_IMPORT_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ providers: { openai: { preset: 'openai', apiKey: 'sk' } } }),
      }),
    );
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[legacy-browser-import]'));
  });

  it('keeps the proposal when the server keeps no settings (404)', async () => {
    const storage = waiting();
    const fetch = vi.fn(async () => new Response('Not found', { status: 404 }));
    expect(await runModelSettingsImport({ fetch, storage })).toBe('kept');
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
  });

  it.each([409, 500, 503])('keeps the proposal on HTTP %i', async (status) => {
    const storage = waiting();
    const fetch = vi.fn(async () => new Response('{}', { status }));
    expect(await runModelSettingsImport({ fetch, storage })).toBe('kept');
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
  });

  it('keeps the proposal on a network error', async () => {
    const storage = waiting();
    const fetch = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(await runModelSettingsImport({ fetch, storage })).toBe('kept');
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).not.toBeNull();
  });

  it('drops a proposal the server refuses (400)', async () => {
    const storage = waiting();
    const fetch = vi.fn(async () => new Response('{}', { status: 400 }));
    expect(await runModelSettingsImport({ fetch, storage })).toBe('dropped');
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
  });

  it('drops an unreadable proposal without sending it', async () => {
    const storage = new MemoryStorage();
    storage.setItem(MODEL_SETTINGS_IMPORT_KEY, '{not json');
    const fetch = vi.fn();
    expect(await runModelSettingsImport({ fetch, storage })).toBe('dropped');
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.getItem(MODEL_SETTINGS_IMPORT_KEY)).toBeNull();
  });
});
