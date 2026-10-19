import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '@/lib/server/provider-config';

const legacy = vi.hoisted(() => ({
  providers: {} as ServerConfig['providers'],
  disabledTts: new Set<string>(),
  webSearch: {} as ServerConfig['webSearch'],
  disabledWebSearch: new Set<string>(),
}));

vi.mock('@/lib/server/provider-config', async (original) => ({
  ...(await original<typeof import('@/lib/server/provider-config')>()),
  getServerProviderConfig: (): ServerConfig => ({
    providers: legacy.providers,
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: legacy.webSearch,
    disabled: {
      tts: legacy.disabledTts,
      asr: new Set(),
      image: new Set(),
      video: new Set(),
      webSearch: legacy.disabledWebSearch,
    },
  }),
}));

const { LegacyRoutesError, loadDeploymentLayer } =
  await import('@/lib/server/model-config/deployment-layer');

const DEPRECATED = /^The model configuration comes from the legacy provider variables/;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-deployment-layer-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  for (const name of [
    'OPENMAIC_CONFIG',
    'DEFAULT_MODEL',
    'MODEL_ROUTES',
    'MODEL_FALLBACK',
    'WEB_SEARCH_KIMI_ENABLED',
    'WEB_SEARCH_DEEPSEEK_ENABLED',
    'VIDEO_VEO_API_KEY',
    'VIDEO_VEO_BASE_URL',
    'VIDEO_VEO_MODELS',
  ]) {
    vi.stubEnv(name, '');
  }
  legacy.providers = {};
  legacy.disabledTts = new Set();
  legacy.webSearch = {};
  legacy.disabledWebSearch = new Set();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadDeploymentLayer', () => {
  it('has no layer when nothing is configured', () => {
    expect(loadDeploymentLayer()).toEqual({ layer: null, legacy: false, notices: [] });
  });

  it('translates the legacy configuration when there is no openmaic.yml', () => {
    legacy.providers = { openai: { apiKey: 'sk-openai' } };
    vi.stubEnv('DEFAULT_MODEL', ' openai:gpt-5.6 ');
    const { layer, legacy: translated, notices } = loadDeploymentLayer();
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(DEPRECATED);
    // One deployment layer: the providers, and the default model as a server
    // default, exactly as openmaic.yml's slots (nothing locked).
    expect(translated).toBe(true);
    expect(layer).toEqual({
      source: 'deployment',
      config: {
        providers: { openai: { preset: 'openai', apiKey: 'sk-openai' } },
        slots: { llm: 'openai:gpt-5.6', agent: null },
      },
    });
    expect(layer?.config.lock).toBeUndefined();
  });

  it('asks for openmaic.yml when MODEL_ROUTES is set', () => {
    legacy.providers = { openai: { apiKey: 'sk-openai' } };
    vi.stubEnv('MODEL_ROUTES', '{"scene-content":{"model":"openai:gpt-5.6"}}');
    expect(() => loadDeploymentLayer()).toThrow(LegacyRoutesError);
    expect(() => loadDeploymentLayer()).toThrow(
      /write the per-stage models as slots in openmaic\.yml/,
    );
  });

  it('ignores MODEL_ROUTES once openmaic.yml exists', () => {
    vi.stubEnv('MODEL_ROUTES', '{"scene-content":{"model":"openai:gpt-5.6"}}');
    fs.writeFileSync(path.join(dir, 'openmaic.yml'), 'slots:\n  video: null\n');
    const { layer, notices } = loadDeploymentLayer();
    expect(layer?.config).toEqual({ slots: { video: null } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^openmaic\.yml is present/);
  });

  it('reports a legacy configuration that only switches providers off', () => {
    legacy.disabledTts = new Set(['browser-native-tts']);
    const { layer, notices } = loadDeploymentLayer();
    expect(layer).toBeNull();
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(DEPRECATED);
    expect(notices[1]).toMatch(/^tts\.browser-native-tts is switched off by the operator/);
  });

  it('uses openmaic.yml over the legacy configuration and says so', () => {
    legacy.providers = { openai: { apiKey: 'sk-openai' } };
    vi.stubEnv('DS_KEY', 'sk-ds');
    fs.writeFileSync(
      path.join(dir, 'openmaic.yml'),
      'providers:\n  ds:\n    preset: deepseek\n    apiKey: ${DS_KEY}\nslots:\n  llm: ds:deepseek-v4-pro\n',
    );
    const { layer, notices } = loadDeploymentLayer();
    expect(layer?.config.slots).toEqual({ llm: 'ds:deepseek-v4-pro' });
    expect(layer?.config.providers).toEqual({ ds: { preset: 'deepseek', apiKey: 'sk-ds' } });
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatch(/^openmaic\.yml is present/);
  });

  it('leaves a retired Veo provider unused, with a notice, instead of refusing the file', () => {
    fs.writeFileSync(
      path.join(dir, 'openmaic.yml'),
      [
        'providers:',
        '  google-video:',
        '    preset: veo',
        '    apiKey: k',
        '  kling:',
        '    preset: kling',
        '    apiKey: k',
        'lock: [video]',
        'slots:',
        '  video: google-video:veo-3.1-generate-preview',
        '  image: null',
        '',
      ].join('\n'),
    );
    const { layer, notices } = loadDeploymentLayer();
    // The provider stays declared (the settings list it, so it can be
    // removed), but no slot resolves through it any more.
    expect(layer?.config.providers).toHaveProperty('google-video');
    expect(layer?.config.slots).toEqual({ image: null });
    expect(notices).toContainEqual(
      expect.stringMatching(
        /^providers\.google-video is not used: the Veo video provider was removed because Google shut down its Veo 3\.1 preview models on October 22, 2026\. Slots that named it follow their parents again/,
      ),
    );
  });

  it('says that the retired VIDEO_VEO_* variables are ignored', () => {
    vi.stubEnv('VIDEO_VEO_API_KEY', 'sk-veo');
    expect(loadDeploymentLayer()).toEqual({
      layer: null,
      legacy: false,
      notices: [
        'VIDEO_VEO_* is set but no longer used: the Veo video provider was removed because Google shut down its Veo 3.1 preview models on October 22, 2026',
      ],
    });
  });

  it('does not mention the legacy configuration when there is none', () => {
    fs.writeFileSync(path.join(dir, 'custom.yml'), 'slots:\n  video: null\n');
    vi.stubEnv('OPENMAIC_CONFIG', 'custom.yml');
    expect(loadDeploymentLayer()).toEqual({
      layer: { source: 'deployment', config: { slots: { video: null } } },
      legacy: false,
      notices: [],
    });
  });
  it('logs each missing model-list warning only once at startup', async () => {
    legacy.providers = { openai: { apiKey: 'operator-secret' } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests();
    runtime.deploymentConfig();
    runtime.deploymentConfig();
    const warnings = warn.mock.calls.map(([message]) => String(message));
    expect(warnings.filter((message) => message.includes('no explicit model list'))).toHaveLength(
      1,
    );
    expect(warnings.join('\n')).toContain(
      'OPENAI_MODELS or server-providers.yml providers.openai.models',
    );
    expect(warnings.join('\n')).toContain('only default/fallback models are usable');
    expect(warnings.join('\n')).not.toContain('operator-secret');
    runtime.setDeploymentConfigForTests();
  });

  it('names the YAML models key for every credentialed provider without a list', () => {
    fs.writeFileSync(
      path.join(dir, 'openmaic.yml'),
      `providers:
  chat:
    preset: openai
    apiKey: operator-chat
  speech:
    preset: openai-tts
    apiKey: operator-speech
  listed:
    preset: seedream
    apiKey: operator-image
    models: [listed-model]
  keyless:
    preset: ollama
`,
    );
    const warnings = loadDeploymentLayer().notices;
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('providers.chat.models');
    expect(warnings[1]).toContain('providers.speech.models');
    expect(warnings.join('\n')).not.toContain('operator-chat');
  });
});

describe('file-backed search opt-in warning', () => {
  it('logs the ignored opt-in warning once, with an actionable slot assignment and no key', async () => {
    vi.stubEnv('WEB_SEARCH_KIMI_ENABLED', 'true');
    legacy.webSearch = { kimi: { apiKey: 'operator-search-secret' } };
    fs.writeFileSync(path.join(dir, 'openmaic.yml'), 'slots:\n  video: null\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests();
    const first = runtime.deploymentConfig();
    expect(first.layer?.config.slots?.webSearch).toBeUndefined();
    expect(runtime.deploymentConfig()).toBe(first);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(
      messages.filter((message) => message.includes('WEB_SEARCH_KIMI_ENABLED is set')),
    ).toHaveLength(1);
    expect(messages.join('\n')).toContain('preset: kimi');
    expect(messages.join('\n')).toContain('assign slots.webSearch');
    expect(messages.join('\n')).not.toContain('operator-search-secret');
    runtime.setDeploymentConfigForTests();
  });

  it.each(['null', 'search'])(
    'does not warn when slots.webSearch is explicitly %s',
    (assignment) => {
      vi.stubEnv('WEB_SEARCH_KIMI_ENABLED', 'true');
      legacy.webSearch = { kimi: { apiKey: 'key' } };
      fs.writeFileSync(
        path.join(dir, 'openmaic.yml'),
        `providers:\n  search:\n    preset: kimi\n    apiKey: key\n    models: [kimi-k3]\nslots:\n  webSearch: ${assignment}\n`,
      );
      expect(loadDeploymentLayer().notices.join('\n')).not.toContain('WEB_SEARCH_KIMI_ENABLED');
    },
  );

  it('does not warn for an absent opt-in, disabled search, or an unloaded provider', () => {
    fs.writeFileSync(path.join(dir, 'openmaic.yml'), 'slots:\n  video: null\n');
    legacy.webSearch = { kimi: { apiKey: 'key' } };
    expect(loadDeploymentLayer().notices.join('\n')).not.toContain('WEB_SEARCH_KIMI_ENABLED');
    vi.stubEnv('WEB_SEARCH_KIMI_ENABLED', 'false');
    legacy.disabledWebSearch.add('kimi');
    expect(loadDeploymentLayer().notices.join('\n')).not.toContain('WEB_SEARCH_KIMI_ENABLED');
    vi.stubEnv('WEB_SEARCH_KIMI_ENABLED', 'true');
    legacy.disabledWebSearch.clear();
    legacy.webSearch = {};
    expect(loadDeploymentLayer().notices.join('\n')).not.toContain('WEB_SEARCH_KIMI_ENABLED');
  });

  it('does not warn when legacy opt-in serves search without openmaic.yml', () => {
    vi.stubEnv('WEB_SEARCH_KIMI_ENABLED', 'true');
    legacy.webSearch = { kimi: { apiKey: 'key' } };
    const deployment = loadDeploymentLayer();
    expect(deployment.layer?.config.slots?.webSearch).toBe('kimi');
    expect(deployment.notices.join('\n')).not.toContain('WEB_SEARCH_KIMI_ENABLED');
  });
});

describe('DeepSeek file-backed search opt-in warning', () => {
  it('logs the ignored opt-in warning once, with an actionable slot assignment and no key', async () => {
    vi.stubEnv('WEB_SEARCH_DEEPSEEK_ENABLED', 'true');
    legacy.webSearch = { deepseek: { apiKey: 'operator-search-secret' } };
    fs.writeFileSync(path.join(dir, 'openmaic.yml'), 'slots:\n  video: null\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests();
    const first = runtime.deploymentConfig();
    expect(first.layer?.config.slots?.webSearch).toBeUndefined();
    expect(runtime.deploymentConfig()).toBe(first);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(
      messages.filter((message) => message.includes('WEB_SEARCH_DEEPSEEK_ENABLED is set')),
    ).toHaveLength(1);
    expect(messages.join('\n')).toContain('preset: deepseek');
    expect(messages.join('\n')).toContain('assign slots.webSearch');
    expect(messages.join('\n')).not.toContain('operator-search-secret');
    runtime.setDeploymentConfigForTests();
  });

  it.each(['null', 'search'])(
    'does not warn when slots.webSearch is explicitly %s',
    (assignment) => {
      vi.stubEnv('WEB_SEARCH_DEEPSEEK_ENABLED', 'true');
      legacy.webSearch = { deepseek: { apiKey: 'key' } };
      fs.writeFileSync(
        path.join(dir, 'openmaic.yml'),
        `providers:\n  search:\n    preset: deepseek\n    apiKey: key\n    models: [deepseek-chat]\nslots:\n  webSearch: ${assignment}\n`,
      );
      expect(loadDeploymentLayer().notices.join('\n')).not.toContain('WEB_SEARCH_DEEPSEEK_ENABLED');
    },
  );

  it('does not warn for an absent opt-in, disabled search, or an unloaded provider', () => {
    fs.writeFileSync(path.join(dir, 'openmaic.yml'), 'slots:\n  video: null\n');
    legacy.webSearch = { deepseek: { apiKey: 'key' } };
    expect(loadDeploymentLayer().notices.join('\n')).not.toContain('WEB_SEARCH_DEEPSEEK_ENABLED');
    vi.stubEnv('WEB_SEARCH_DEEPSEEK_ENABLED', 'false');
    legacy.disabledWebSearch.add('deepseek');
    expect(loadDeploymentLayer().notices.join('\n')).not.toContain('WEB_SEARCH_DEEPSEEK_ENABLED');
    vi.stubEnv('WEB_SEARCH_DEEPSEEK_ENABLED', 'true');
    legacy.disabledWebSearch.clear();
    legacy.webSearch = {};
    expect(loadDeploymentLayer().notices.join('\n')).not.toContain('WEB_SEARCH_DEEPSEEK_ENABLED');
  });

  it('does not warn when legacy opt-in serves search without openmaic.yml', () => {
    vi.stubEnv('WEB_SEARCH_DEEPSEEK_ENABLED', 'true');
    legacy.webSearch = { deepseek: { apiKey: 'key' } };
    const deployment = loadDeploymentLayer();
    expect(deployment.layer?.config.slots?.webSearch).toBe('deepseek');
    expect(deployment.notices.join('\n')).not.toContain('WEB_SEARCH_DEEPSEEK_ENABLED');
  });
});
