import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { translateLegacyConfig } from '@/lib/server/model-config/legacy-config';
import { parseModelConfig } from '@/lib/server/model-config/openmaic-yml';
import { resolveSlot } from '@/lib/server/model-config/resolve-slot';
import type { StageRoute } from '@/lib/server/model-routes';
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

  it('leaves out providers the operator force-disabled', () => {
    const disabled = server({
      webSearch: { tavily: { apiKey: 'tv' }, bocha: { apiKey: 'bc' } },
      disabled: {
        tts: new Set(),
        asr: new Set(),
        image: new Set(),
        video: new Set(),
        webSearch: new Set(['tavily']),
      },
    });
    const { config, notices } = translateLegacyConfig(disabled);
    expect(Object.keys(config.providers ?? {})).toEqual(['bocha']);
    expect(notices).toEqual([
      'webSearch.tavily is disabled by the operator and is not carried over',
    ]);
  });
});

describe('translateLegacyConfig: models', () => {
  const route = (model: string, extra: Partial<StageRoute> = {}): StageRoute => ({
    model,
    ...extra,
  });

  it('puts DEFAULT_MODEL on the llm root', () => {
    const { config } = translateLegacyConfig(withProviders, { defaultModel: 'openai:gpt-5.6' });
    expect(config.slots).toEqual({ llm: 'openai:gpt-5.6' });
  });

  it('leaves a model whose provider has no server configuration to the browser', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'anthropic:claude',
    });
    expect(config.slots).toBeUndefined();
    expect(notices).toEqual([
      'DEFAULT_MODEL uses provider "anthropic", which has no server configuration; it is left to the browser',
    ]);
  });

  it('maps stage routes onto their slots, keeping options', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      stageRoutes: {
        'scene-content:slide': route('deepseek:deepseek-v4-pro', { thinking: { enabled: false } }),
        'scene-outlines-stream': route('deepseek:deepseek-v4-flash', {
          fallback: 'openai:gpt-5.6',
        }),
        'maic-agent-driver': route('openai:gpt-5.6', {
          api: 'openai-responses',
          contextWindow: 200000,
        }),
      },
    });
    expect(notices).toEqual([]);
    expect(config.slots).toEqual({
      llm: 'openai:gpt-5.6',
      'course.content.slide': { model: 'deepseek:deepseek-v4-pro', thinking: { enabled: false } },
      'course.outline': { model: 'deepseek:deepseek-v4-flash', fallback: 'openai:gpt-5.6' },
      agent: { model: 'openai:gpt-5.6', api: 'openai-responses', contextWindow: 200000 },
      // conversation-title has no route, so it stays on DEFAULT_MODEL rather
      // than inheriting the agent driver's options.
      'agent.title': 'openai:gpt-5.6',
    });
  });

  it('keeps unrouted stages on DEFAULT_MODEL under a routed parent', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      stageRoutes: {
        'scene-content': route('deepseek:deepseek-v4-pro'),
        'scene-content:slide': route('deepseek:deepseek-v4-pro'),
        'scene-content:quiz': route('deepseek:deepseek-v4-pro'),
        'maic-agent-driver': route('deepseek:deepseek-v4-pro'),
      },
    });
    expect(notices).toEqual([]);
    expect(config.slots).toEqual({
      llm: 'openai:gpt-5.6',
      'course.content': 'deepseek:deepseek-v4-pro',
      // Neither had a route (not even through scene-content in this fixture).
      'course.content.interactive': 'openai:gpt-5.6',
      'course.content.pbl': 'openai:gpt-5.6',
      agent: 'deepseek:deepseek-v4-pro',
      'agent.title': 'openai:gpt-5.6',
    });
    const layers = [{ source: 'deployment' as const, config: config }];
    expect(resolveSlot('agent.title', layers)).toMatchObject({ modelId: 'gpt-5.6' });
    expect(resolveSlot('course.outline', layers)).toMatchObject({ modelId: 'gpt-5.6' });
  });

  it('reports stages that used the browser but would inherit a server route', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      stageRoutes: {
        'generate-classroom': route('deepseek:deepseek-v4-pro'),
        'maic-agent-driver': route('openai:gpt-5.6'),
      },
    });
    expect(config.slots).toEqual({
      llm: 'deepseek:deepseek-v4-pro',
      agent: 'openai:gpt-5.6',
    });
    expect(notices).toEqual([
      "course.research, course.outline, course.agents, course.content, course.content.slide, course.content.quiz, course.content.interactive, course.content.pbl, course.actions, classroom, agent.title used the browser's model and now inherit a server model; set them in openmaic.yml to change that",
    ]);
  });

  it('assigns a shared slot only when all of its stages agree', () => {
    const pbl = route('deepseek:deepseek-v4-pro');
    const allClassroom = {
      'chat-adapter': pbl,
      'quiz-grade': pbl,
      'pbl-v2-runtime': pbl,
      'pbl-v2-runtime:instructor': pbl,
      'pbl-v2-runtime:open-task': pbl,
      'pbl-v2-runtime:evaluate': pbl,
      'pbl-v2-runtime:simulator': pbl,
    };
    expect(
      translateLegacyConfig(withProviders, { stageRoutes: allClassroom }).config.slots,
    ).toEqual({
      classroom: 'deepseek:deepseek-v4-pro',
    });

    // Only the PBL runtime is routed: chat and grading still use the default
    // model, which one classroom slot cannot express.
    const pblOnly = { 'pbl-v2-runtime': pbl, 'pbl-v2-runtime:instructor': pbl };
    const { config, notices } = translateLegacyConfig(withProviders, { stageRoutes: pblOnly });
    expect(config.slots).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(
      /^MODEL_ROUTES gives the stages that now share the slot classroom different models/,
    );
  });

  it('lets a scene type inherit when it only follows the scene-content route', () => {
    const content = route('deepseek:deepseek-v4-pro');
    const { config } = translateLegacyConfig(withProviders, {
      stageRoutes: {
        'scene-content': content,
        'scene-content:slide': content,
        'scene-content:quiz': content,
        'scene-content:interactive': route('openai:gpt-5.6'),
        'scene-content:pbl': content,
      },
    });
    expect(config.slots).toEqual({
      'course.content': 'deepseek:deepseek-v4-pro',
      'course.content.interactive': 'openai:gpt-5.6',
    });
  });

  it('keeps DEFAULT_MODEL on llm when generate-classroom is routed elsewhere', () => {
    const { config, notices } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      stageRoutes: { 'generate-classroom': route('deepseek:deepseek-v4-pro') },
    });
    expect(config.slots).toEqual({ llm: 'openai:gpt-5.6' });
    expect(notices).toEqual([
      'MODEL_ROUTES.generate-classroom differs from DEFAULT_MODEL; DEFAULT_MODEL is kept for the llm slot',
    ]);
  });

  it('applies MODEL_FALLBACK where a route has no fallback of its own', () => {
    const { config } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: 'deepseek:deepseek-v4-flash',
      stageRoutes: {
        'scene-actions': route('deepseek:deepseek-v4-pro'),
        'agent-profiles': route('deepseek:deepseek-v4-pro', { fallback: 'openai:gpt-5.6' }),
      },
    });
    expect(config.slots).toEqual({
      llm: { model: 'openai:gpt-5.6', fallback: 'deepseek:deepseek-v4-flash' },
      'course.actions': {
        model: 'deepseek:deepseek-v4-pro',
        fallback: 'deepseek:deepseek-v4-flash',
      },
      'course.agents': { model: 'deepseek:deepseek-v4-pro', fallback: 'openai:gpt-5.6' },
    });
  });
});

describe('translateLegacyConfig output', () => {
  it('is a valid openmaic.yml that resolves the same models', () => {
    const { config } = translateLegacyConfig(withProviders, {
      defaultModel: 'openai:gpt-5.6',
      globalFallback: 'deepseek:deepseek-v4-flash',
      stageRoutes: { 'scene-content:slide': { model: 'deepseek:deepseek-v4-pro' } },
    });
    const reparsed = parseModelConfig(yaml.dump(config), { env: {} });
    expect(reparsed).toEqual(config);
    const layers = [{ source: 'deployment' as const, config: reparsed }];
    expect(resolveSlot('course.outline', layers)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.6',
      fallback: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
    });
    expect(resolveSlot('course.content.slide', layers)).toMatchObject({
      modelId: 'deepseek-v4-pro',
    });
  });
});
