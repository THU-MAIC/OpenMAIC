import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deprecatedProviderSettings } from '@/lib/server/provider-config';
import { loadDeploymentLayer } from '@/lib/server/model-config/deployment-layer';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmaic-deployment-layer-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  for (const name of [
    'OPENMAIC_CONFIG',
    'ANTHROPIC_BASE_URL',
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

  it('does not report legacy settings for a stock .env.example', () => {
    const template = fs.readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    expect(deprecatedProviderSettings(parseEnv(template), new Set())).toEqual([]);
  });

  it('reports deprecated setting names without configuring a model', () => {
    vi.stubEnv('OPENAI_API_KEY', 'operator-secret');
    vi.stubEnv('DEFAULT_MODEL', 'openai:gpt-5.6');
    vi.stubEnv('MODEL_ROUTES', 'legacy-routes');
    vi.stubEnv('MODEL_FALLBACK', 'legacy-fallback');
    fs.writeFileSync(path.join(dir, 'server-providers.yml'), 'not even valid YAML: [');
    const { layer, notices } = loadDeploymentLayer();
    expect(layer).toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(
      'DEFAULT_MODEL, MODEL_FALLBACK, MODEL_ROUTES, OPENAI_API_KEY, server-providers.yml',
    );
    expect(notices[0]).toContain('#migrating-from-the-legacy-configuration');
    expect(notices[0]).not.toMatch(/operator-secret|legacy-routes|legacy-fallback/);
  });

  it('does not warn about a force-off-only server-providers.yml', () => {
    fs.writeFileSync(
      path.join(dir, 'server-providers.yml'),
      'tts:\n  qwen-tts: { enabled: false }\nweb-search:\n  searxng: { enabled: false }\n',
    );
    const { layer, notices } = loadDeploymentLayer();
    expect(layer).toBeNull();
    expect(notices).toEqual([]);
  });

  it.each([
    'tts:\n  qwen-tts: { enabled: false, apiKey: example-key }\n',
    'providers:\n  openai: { enabled: false }\n',
    'web-search:\n  searxng: { enabled: true }\n',
  ])('warns when server-providers.yml contains ignored settings (%s)', (yaml) => {
    fs.writeFileSync(path.join(dir, 'server-providers.yml'), yaml);
    const { layer, notices } = loadDeploymentLayer();
    expect(layer).toBeNull();
    expect(notices.join(' ')).toContain(
      'Deprecated provider settings detected: server-providers.yml.',
    );
    expect(notices.join(' ')).not.toContain('example-key');
  });

  it('accepts an env variable referenced by openmaic.yml and warns about unused legacy settings', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'operator-secret');
    vi.stubEnv('DEFAULT_MODEL', 'openai:gpt-5.6');
    fs.writeFileSync(
      path.join(dir, 'openmaic.yml'),
      [
        'providers:',
        '  ds:',
        '    preset: deepseek',
        '    apiKey: ${DEEPSEEK_API_KEY}',
        '    models: [deepseek-v4-pro]',
        'slots:',
        '  llm: ds:deepseek-v4-pro',
      ].join('\n'),
    );
    const { layer, notices } = loadDeploymentLayer();
    expect(layer?.config.slots).toEqual({ llm: 'ds:deepseek-v4-pro' });
    expect(layer?.config.providers?.ds?.apiKey).toBe('operator-secret');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('DEFAULT_MODEL');
    expect(notices[0]).not.toMatch(/DEEPSEEK_API_KEY|operator-secret/);
  });

  it('uses BEDROCK_REGION for a declared Bedrock provider without a migration warning', () => {
    vi.stubEnv('BEDROCK_REGION', 'us-west-2');
    expect(loadDeploymentLayer().notices.join(' ')).toContain('BEDROCK_REGION');
    fs.writeFileSync(path.join(dir, 'openmaic.yml'), 'providers:\n  aws:\n    preset: bedrock\n');
    const deployment = loadDeploymentLayer();
    expect(deployment.layer?.config.providers?.aws.preset).toBe('bedrock');
    expect(deployment.notices.join(' ')).not.toContain('BEDROCK_REGION');
  });

  it('warns about a legacy AliDocMind endpoint unless the deployment references it', () => {
    vi.stubEnv('ALIDOCMIND_BASE_URL', 'https://example.com');
    const old = loadDeploymentLayer();
    expect(old.layer).toBeNull();
    expect(old.notices.join(' ')).toContain('ALIDOCMIND_BASE_URL');
    expect(old.notices.join(' ')).not.toContain('https://example.com');
    fs.writeFileSync(
      path.join(dir, 'openmaic.yml'),
      [
        'providers:',
        '  docs:',
        '    preset: alidocmind',
        '    baseUrl: ${ALIDOCMIND_BASE_URL}',
      ].join('\n'),
    );
    const migrated = loadDeploymentLayer();
    expect(migrated.layer?.config.providers?.docs.baseUrl).toBe('https://example.com');
    expect(migrated.notices.join(' ')).not.toContain('ALIDOCMIND_BASE_URL');
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
