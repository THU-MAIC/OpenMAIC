import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { translateLegacyConfig } from '@/lib/server/model-config/legacy-config';
import { parseModelConfig } from '@/lib/server/model-config/openmaic-yml';
import { resolveSlot } from '@/lib/server/model-config/resolve-slot';
import { lookupFromLayers } from '@/lib/server/model-config/runtime';
import type { ServerConfig } from '@/lib/server/provider-config';

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    providers: {},
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
    disabled: {
      tts: new Set(),
      asr: new Set(),
      image: new Set(),
      video: new Set(),
      webSearch: new Set(),
    },
    ...overrides,
  };
}

const withProviders = server({
  providers: {
    openai: { apiKey: 'sk-openai', models: ['gpt-5.6'], proxy: 'http://127.0.0.1:7890' },
    deepseek: { apiKey: 'sk-ds' },
    ollama: { apiKey: '', baseUrl: 'http://ollama:11434/v1' },
  },
  tts: { 'minimax-tts': { apiKey: 'sk-mm' } },
  webSearch: { minimax: { apiKey: 'sk-mm' }, tavily: { apiKey: 'tv' } },
  image: { lemonade: { apiKey: '', baseUrl: 'http://lemonade:8000' } },
  pdf: { alidocmind: { apiKey: '', accessKeyId: 'ak', accessKeySecret: 'sk' } },
});

const noDisabled = (): ServerConfig['disabled'] => ({
  tts: new Set(),
  asr: new Set(),
  image: new Set(),
  video: new Set(),
  webSearch: new Set(),
});

describe('translateLegacyConfig: providers', () => {
  it('declares every configured provider under its preset id', () => {
    const { config, notices } = translateLegacyConfig(withProviders);
    expect(notices).toEqual([]);
    expect(config.providers).toEqual({
      openai: {
        preset: 'openai',
        apiKey: 'sk-openai',
        models: ['gpt-5.6'],
        proxy: 'http://127.0.0.1:7890',
      },
      deepseek: { preset: 'deepseek', apiKey: 'sk-ds' },
      ollama: { preset: 'ollama', baseUrl: 'http://ollama:11434/v1' },
      'minimax-tts': { preset: 'minimax-tts', apiKey: 'sk-mm' },
      'minimax-search': { preset: 'minimax-search', apiKey: 'sk-mm' },
      tavily: { preset: 'tavily', apiKey: 'tv' },
      'lemonade-image': { preset: 'lemonade-image', baseUrl: 'http://lemonade:8000' },
      alidocmind: {
        preset: 'alidocmind',
        credentials: { accessKeyId: 'ak', accessKeySecret: 'sk' },
      },
    });
  });

  it('leaves out switched-off providers and says the switch does not carry over', () => {
    const disabled = server({
      webSearch: { tavily: { apiKey: 'tv' }, bocha: { apiKey: 'bc' } },
      disabled: {
        ...noDisabled(),
        webSearch: new Set(['tavily']),
        tts: new Set(['browser-native-tts']),
      },
    });
    const { config, notices } = translateLegacyConfig(disabled);
    expect(Object.keys(config.providers ?? {})).toEqual(['bocha']);
    expect(notices).toEqual([
      'tts.browser-native-tts is switched off by the operator; openmaic.yml has no such switch, so leave it out or set its slot to null',
      'webSearch.tavily is switched off by the operator; openmaic.yml has no such switch, so leave it out or set its slot to null',
    ]);
  });

  it('leaves out entries the new schema rejects, naming fields and not values', () => {
    const { config, notices } = translateLegacyConfig(
      server({
        providers: {
          azure: { apiKey: 'sk-azure' },
          openai: { apiKey: 'sk-openai', baseUrl: 'sk-pasted-here' },
          deepseek: { apiKey: 'sk-ds' },
        },
      }),
    );
    expect(Object.keys(config.providers ?? {})).toEqual(['deepseek']);
    expect(notices).toEqual([
      'providers.azure is not carried over: it needs a base URL',
      'providers.openai is not carried over: invalid baseUrl',
    ]);
  });
});

/** The chat part of translated slots (the media defaults are tested apart). */
function chatSlots(slots: Record<string, unknown> | undefined) {
  if (!slots) return undefined;
  const chat = Object.fromEntries(
    Object.entries(slots).filter(([slot]) => slot === 'llm' || slot === 'agent'),
  );
  return Object.keys(chat).length ? chat : undefined;
}

describe('translateLegacyConfig: media defaults', () => {
  it('assigns each media root the provider the server picked when a request named none', () => {
    const { config } = translateLegacyConfig(
      server({
        tts: { 'minimax-tts': { apiKey: 'sk', models: ['speech-2.8-turbo'] } },
        image: { seedream: { apiKey: 'sk' }, 'qwen-image': { apiKey: 'sk' } },
        webSearch: { claude: { apiKey: 'c' }, exa: { apiKey: 'e' } },
        pdf: { mineru: { apiKey: 'm', baseUrl: 'https://mineru.example' } },
      }),
    );
    expect(config.slots).toEqual({
      tts: 'minimax-tts:speech-2.8-turbo',
      image: 'seedream',
      // By the old priority, not by order: exa before claude.
      webSearch: 'exa',
      document: 'mineru',
    });
    const layers = [{ source: 'deployment' as const, config }];
    expect(resolveSlot('webSearch', layers)).toMatchObject({ registryId: 'exa', apiKey: 'e' });
  });

  it('prefers DEFAULT_IMAGE_PROVIDER when it names a usable image provider', () => {
    const images = server({
      image: { seedream: { apiKey: 'sk' }, 'qwen-image': { apiKey: 'sk' } },
    });
    expect(
      translateLegacyConfig(images, { defaultImageProvider: 'qwen-image' }).config.slots,
    ).toEqual({ image: 'qwen-image' });
    // One that is not usable leaves the slot unassigned, never another vendor.
    const unusable = translateLegacyConfig(images, { defaultImageProvider: 'grok-image' });
    expect(unusable.config.slots).toBeUndefined();
    expect(unusable.notices.join('\n')).toContain('DEFAULT_IMAGE_PROVIDER "grok-image"');
  });

  it('prefers MinerU Cloud, then self-hosted MinerU, for the document root', () => {
    const document = (pdf: ServerConfig['pdf']) =>
      translateLegacyConfig(server({ pdf })).config.slots?.document;
    const alidocmind = { apiKey: '', accessKeyId: 'ak', accessKeySecret: 'sk' };
    const unpdf = { apiKey: '', baseUrl: 'http://unpdf.example' };
    const mineru = { apiKey: 'm', baseUrl: 'https://mineru.example' };
    const cloud = { apiKey: 'c' };
    // Ahead of the configuration order (unpdf, mineru, mineru-cloud, alidocmind).
    expect(document({ unpdf, mineru, 'mineru-cloud': cloud, alidocmind })).toBe('mineru-cloud');
    expect(document({ unpdf, mineru, alidocmind })).toBe('mineru');
    // Without MinerU, the first configured service, as before.
    expect(document({ unpdf, alidocmind })).toBe('unpdf');
    expect(document({ alidocmind })).toBe('alidocmind');
  });

  it('skips providers that were switched off or did not carry over', () => {
    const { config } = translateLegacyConfig(
      server({
        video: { seedance: { apiKey: 'sk' }, kling: { apiKey: 'sk' } },
        disabled: { ...noDisabled(), video: new Set(['seedance']) },
      }),
    );
    expect(config.slots).toEqual({ video: 'kling' });
  });
});

describe('translateLegacyConfig: media defaults after an upgrade', () => {
  // Before the server-side settings, the browser switched image, video and
  // narration on at its first sync with the server whenever the server had a
  // provider for them, and the classroom chat and the agent searched the web
  // whenever a search provider was configured. The translated defaults keep
  // those capabilities on, and switchable by each workspace.
  const legacy = server({
    tts: { 'minimax-tts': { apiKey: 'sk' } },
    image: { seedream: { apiKey: 'sk' } },
    video: { seedance: { apiKey: 'sk' } },
    webSearch: { tavily: { apiKey: 'tv' } },
  });
  const { config } = translateLegacyConfig(legacy);
  // Translated, they are server defaults exactly as `slots` in openmaic.yml.
  const deployment = { source: 'deployment' as const, config };
  const slots = ['tts', 'image', 'video', 'webSearch'] as const;

  it('starts on with the configured provider, as a server default locking nothing', () => {
    for (const slot of slots) {
      expect(lookupFromLayers(slot, { deployment, workspace: null })).toMatchObject({
        status: 'assigned',
        source: 'default',
        locked: false,
      });
    }
  });

  it('is switched off by a workspace', () => {
    const workspace = {
      source: 'workspace' as const,
      config: { slots: { tts: null, image: null, video: null, webSearch: null } },
    };
    for (const slot of slots) {
      expect(lookupFromLayers(slot, { deployment, workspace })).toMatchObject({
        status: 'disabled',
        source: 'workspace',
      });
    }
  });

  it('leaves an openmaic.yml assignment a default too, locked only by lock', () => {
    const file = {
      source: 'deployment' as const,
      config: {
        providers: { sd: { preset: 'seedream', apiKey: 'sk' } },
        slots: { image: 'sd', video: null },
      },
    };
    const workspace = { source: 'workspace' as const, config: { slots: { image: null } } };
    expect(lookupFromLayers('image', { deployment: file, workspace })).toMatchObject({
      status: 'disabled',
      source: 'workspace',
      locked: false,
    });
    const locked = { ...file, config: { ...file.config, lock: ['image', 'video'] } };
    expect(lookupFromLayers('image', { deployment: locked, workspace })).toMatchObject({
      status: 'assigned',
      source: 'locked',
      locked: true,
    });
    expect(lookupFromLayers('video', { deployment: locked, workspace: null })).toMatchObject({
      status: 'disabled',
      locked: true,
    });
  });
});

describe('translateLegacyConfig: models', () => {
  it('puts DEFAULT_MODEL on the llm root and keeps the agent off', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
    });
    expect(notices).toEqual([]);
    expect(chatSlots(config.slots)).toEqual({ llm: 'openai:gpt-5.6', agent: null });
    const layers = [{ source: 'deployment' as const, config }];
    expect(resolveSlot('course.content.slide', layers)).toMatchObject({ modelId: 'gpt-5.6' });
    expect(resolveSlot('agent', layers)).toMatchObject({ status: 'disabled' });
    expect(resolveSlot('agent.title', layers)).toMatchObject({ status: 'disabled' });
  });

  it('attaches MODEL_FALLBACK to the llm root', () => {
    const { config } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: 'deepseek:deepseek-v4-flash',
    });
    expect(chatSlots(config.slots)).toEqual({
      llm: { model: 'openai:gpt-5.6', fallback: 'deepseek:deepseek-v4-flash' },
      agent: null,
    });
  });

  it('drops MODEL_FALLBACK without DEFAULT_MODEL', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      globalFallback: 'deepseek:deepseek-v4-flash',
    });
    expect(chatSlots(config.slots)).toBeUndefined();
    expect(notices).toEqual([
      'MODEL_FALLBACK is not carried over without DEFAULT_MODEL, so calls that retried on it no longer do; set the llm slot with a fallback in openmaic.yml',
    ]);
  });

  it('leaves the agent open when there is no server model at all', () => {
    expect(chatSlots(translateLegacyConfig(withProviders).config.slots)).toBeUndefined();
  });

  it('leaves a model whose provider has no server configuration to the browser', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'anthropic:claude',
    });
    expect(chatSlots(config.slots)).toBeUndefined();
    expect(notices).toEqual([
      'DEFAULT_MODEL uses provider "anthropic" without server configuration; each workspace chooses its model in Settings → Course Model Config, or configure that provider and set DEFAULT_MODEL',
    ]);
  });

  it('never repeats a credential pasted into a model variable', () => {
    const secret = 'sk-live-0123456789';
    const { notices } = translateLegacyConfig(withProviders, {
      defaultModel: `${secret}:m`,
      globalFallback: `openai:gpt-5.6`,
    });
    expect(notices).toEqual([
      'DEFAULT_MODEL uses a provider without server configuration; each workspace chooses its model in Settings → Course Model Config, or configure that provider and set DEFAULT_MODEL',
      'MODEL_FALLBACK is not carried over without DEFAULT_MODEL, so calls that retried on it no longer do; set the llm slot with a fallback in openmaic.yml',
    ]);
    const fallback = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: `${secret}:m`,
    });
    expect(chatSlots(fallback.config.slots)).toEqual({ llm: 'openai:gpt-5.6', agent: null });
    for (const notice of [...notices, ...fallback.notices]) expect(notice).not.toContain(secret);
  });

  it('refers only to chat providers translated from the providers section', () => {
    // The same id under providers (no preset offers chat for it) and tts.
    const { config, notices } = translateLegacyConfig(
      server({
        providers: { 'minimax-tts': { apiKey: 'sk-a' } },
        tts: { 'minimax-tts': { apiKey: 'sk-b' } },
      }),
      { defaultModel: 'minimax-tts:speech-2.8-turbo' },
    );
    expect(chatSlots(config.slots)).toBeUndefined();
    expect(notices).toEqual([
      'An entry in providers has no matching preset and is not carried over',
      'DEFAULT_MODEL uses a provider without server configuration; each workspace chooses its model in Settings → Course Model Config, or configure that provider and set DEFAULT_MODEL',
    ]);
  });

  it('refuses a malformed model id', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt\nsecond-line',
    });
    expect(chatSlots(config.slots)).toBeUndefined();
    expect(notices).toEqual([
      'DEFAULT_MODEL is not a valid model reference and is not carried over',
    ]);
  });

  it('does not repeat keys that are not registry ids', () => {
    const secret = 'sk-live-0123456789';
    const { config, notices } = translateLegacyConfig(
      server({
        providers: { [secret]: { apiKey: 'x' }, deepseek: { apiKey: 'sk-ds' } },
        disabled: { ...noDisabled(), tts: new Set([secret]) },
      }),
    );
    expect(Object.keys(config.providers ?? {})).toEqual(['deepseek']);
    expect(notices).toEqual([
      'An entry in providers has no matching preset and is not carried over',
    ]);
  });
});

describe('translateLegacyConfig output', () => {
  it('is a valid openmaic.yml that resolves the same models', () => {
    const { config } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: 'deepseek:deepseek-v4-flash',
    });
    const reparsed = parseModelConfig(yaml.dump(config), { env: {} });
    expect(reparsed).toEqual(config);
    const layers = [{ source: 'deployment' as const, config: reparsed }];
    expect(resolveSlot('course.outline', layers)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.6',
      fallback: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    });
    expect(resolveSlot('tts', layers)).toMatchObject({ registryId: 'minimax-tts' });
  });
});
