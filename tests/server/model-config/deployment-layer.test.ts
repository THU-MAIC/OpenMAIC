import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRoute } from '@/lib/server/model-routes';
import type { ServerConfig } from '@/lib/server/provider-config';

const legacy = vi.hoisted(() => ({
  providers: {} as ServerConfig['providers'],
  routes: {} as Record<string, StageRoute>,
  disabledTts: new Set<string>(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerProviderConfig: (): ServerConfig => ({
    providers: legacy.providers,
    tts: {},
    asr: {},
    pdf: {},
    image: {},
    video: {},
    webSearch: {},
    disabled: {
      tts: legacy.disabledTts,
      asr: new Set(),
      image: new Set(),
      video: new Set(),
      webSearch: new Set(),
    },
  }),
}));

vi.mock('@/lib/server/model-routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-routes')>()),
  getStageRoute: (stage: string) => legacy.routes[stage],
}));

const { loadDeploymentLayer } = await import('@/lib/server/model-config/deployment-layer');

const DEPRECATED = /^The model configuration comes from the legacy provider variables/;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-deployment-layer-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  for (const name of ['OPENMAIC_CONFIG', 'DEFAULT_MODEL', 'MODEL_ROUTES', 'MODEL_FALLBACK']) {
    vi.stubEnv(name, '');
  }
  legacy.providers = {};
  legacy.routes = {};
  legacy.disabledTts = new Set();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadDeploymentLayer', () => {
  it('has no layer when nothing is configured', () => {
    expect(loadDeploymentLayer()).toEqual({ layer: null, notices: [] });
  });

  it('translates the legacy configuration when there is no openmaic.yml', () => {
    legacy.providers = { openai: { apiKey: 'sk-openai' } };
    legacy.routes = { 'conversation-title': { model: 'openai:gpt-5.6-mini' } };
    vi.stubEnv('DEFAULT_MODEL', ' openai:gpt-5.6 ');
    const { layer, notices } = loadDeploymentLayer();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(DEPRECATED);
    expect(layer).toEqual({
      source: 'deployment',
      config: {
        providers: { openai: { preset: 'openai', apiKey: 'sk-openai' } },
        slots: {
          llm: 'openai:gpt-5.6',
          agent: null,
          'agent.title': { model: 'openai:gpt-5.6-mini', thinking: { mode: 'disabled' } },
        },
      },
    });
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
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^openmaic\.yml is present/);
  });

  it('does not mention the legacy configuration when there is none', () => {
    fs.writeFileSync(path.join(dir, 'custom.yml'), 'slots:\n  video: null\n');
    vi.stubEnv('OPENMAIC_CONFIG', 'custom.yml');
    expect(loadDeploymentLayer()).toEqual({
      layer: { source: 'deployment', config: { slots: { video: null } } },
      notices: [],
    });
  });
});
