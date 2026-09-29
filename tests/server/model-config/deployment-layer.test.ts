import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRoute } from '@/lib/server/model-routes';
import type { ServerConfig } from '@/lib/server/provider-config';

const legacy = vi.hoisted(() => ({
  providers: {} as ServerConfig['providers'],
  routes: {} as Record<string, StageRoute>,
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
      tts: new Set(),
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

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-deployment-layer-'));
  legacy.providers = {};
  legacy.routes = {};
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadDeploymentLayer', () => {
  it('has no layer when nothing is configured', () => {
    expect(loadDeploymentLayer({}, dir)).toEqual({ layer: null, notices: [] });
  });

  it('translates the legacy configuration when there is no openmaic.yml', () => {
    legacy.providers = { openai: { apiKey: 'sk-openai' } };
    legacy.routes = { 'conversation-title': { model: 'openai:gpt-5.6-mini' } };
    const { layer, notices } = loadDeploymentLayer({ DEFAULT_MODEL: ' openai:gpt-5.6 ' }, dir);
    expect(notices).toEqual([]);
    expect(layer).toEqual({
      source: 'deployment',
      config: {
        providers: { openai: { preset: 'openai', apiKey: 'sk-openai' } },
        slots: { llm: 'openai:gpt-5.6', 'agent.title': 'openai:gpt-5.6-mini' },
      },
    });
  });

  it('uses openmaic.yml over the legacy configuration and says so', () => {
    legacy.providers = { openai: { apiKey: 'sk-openai' } };
    fs.writeFileSync(
      path.join(dir, 'openmaic.yml'),
      'providers:\n  ds:\n    preset: deepseek\n    apiKey: ${DS_KEY}\nslots:\n  llm: ds:deepseek-v4-pro\n',
    );
    const { layer, notices } = loadDeploymentLayer({ DS_KEY: 'sk-ds' }, dir);
    expect(layer?.config.slots).toEqual({ llm: 'ds:deepseek-v4-pro' });
    expect(layer?.config.providers).toEqual({ ds: { preset: 'deepseek', apiKey: 'sk-ds' } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^openmaic\.yml is present/);
  });

  it('does not mention the legacy configuration when there is none', () => {
    fs.writeFileSync(path.join(dir, 'custom.yml'), 'slots:\n  video: null\n');
    expect(loadDeploymentLayer({ OPENMAIC_CONFIG: 'custom.yml' }, dir)).toEqual({
      layer: { source: 'deployment', config: { slots: { video: null } } },
      notices: [],
    });
  });
});
