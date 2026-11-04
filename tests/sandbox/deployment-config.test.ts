import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { parseModelConfig } from '@/lib/server/model-config/openmaic-yml';
import { loadDeploymentLayer } from '@/lib/server/model-config/deployment-layer';
import { modelSettingsView } from '@/lib/server/model-config/settings';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { sandboxDefaults } from '@/lib/sandbox/config-schema';

const yaml = `sandbox:
  enabled: true
  connectionId: example
  apiKey: \${SANDBOX_KEY}
  template: code
`;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbox-config-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  for (const key of Object.keys(process.env))
    if (key.startsWith('OPENMAIC_SANDBOX_') || key.startsWith('E2B_')) vi.stubEnv(key, undefined);
  vi.stubEnv('OPENMAIC_CONFIG', '');
  vi.stubEnv('MODEL_ROUTES', '');
  vi.stubEnv('SANDBOX_KEY', 'deployment-secret');
});
afterEach(() => {
  setDeploymentConfigForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
describe('sandbox deployment layer', () => {
  it('uses the shared YAML loader, interpolation and defaults', () => {
    writeFileSync(join(dir, 'openmaic.yml'), yaml);
    expect(loadDeploymentLayer().layer?.config.sandbox).toEqual({
      ...sandboxDefaults,
      enabled: true,
      connectionId: 'example',
      apiKey: 'deployment-secret',
      template: 'code',
    });
  });
  it.each(['all', '[sandbox]', '[sandbox, llm]'])(
    'accepts lock %s without changing slot validation',
    (lock) => {
      expect(parseModelConfig(`${yaml}slots:\n  llm: null\nlock: ${lock}\n`).lock).toBeDefined();
      expect(() => parseModelConfig(`${yaml}lock: [sandbox, not-a-slot]`)).toThrow('lock.1');
    },
  );
  it('can lock an absent sandbox section off', () => {
    expect(parseModelConfig('lock: [sandbox]')).toEqual({ lock: ['sandbox'] });
  });
  it('reports a missing referenced key by its exact YAML path at startup', () => {
    vi.stubEnv('SANDBOX_KEY', '');
    writeFileSync(join(dir, 'openmaic.yml'), yaml);
    expect(() => loadDeploymentLayer()).toThrow('sandbox.apiKey');
  });
  it.each([
    ['lifetimeMs: 1', 'sandbox.lifetimeMs'],
    ['maxActive: 0', 'sandbox.maxActive'],
    ['maxActivePerOwner: 6', 'sandbox.maxActivePerOwner'],
    ['apiUrl: http://unsafe.example', 'sandbox.apiUrl'],
    ['domain: https://wrong.example', 'sandbox.domain'],
    ['provider: unsupported', 'sandbox.provider'],
    ['unknown: value', 'sandbox'],
  ])('rejects invalid YAML %s before serving requests', (field, location) => {
    writeFileSync(join(dir, 'openmaic.yml'), `${yaml}  ${field}\n`);
    expect(() => loadDeploymentLayer()).toThrow(location);
  });
  it('does not quote credentials in validation errors', () => {
    expect(() =>
      parseModelConfig(`${yaml}  apiUrl: https://user:private-password@api.example\n`),
    ).toThrow('sandbox.apiUrl');
    try {
      parseModelConfig(`${yaml}  apiUrl: https://user:private-password@api.example\n`);
    } catch (error) {
      expect(String(error)).not.toMatch(/private-password|deployment-secret/);
    }
  });
  it('requires an explicit control-plane origin for a custom runtime domain', () => {
    expect(() => parseModelConfig(`${yaml}  domain: runtime.example\n`)).toThrow('sandbox.apiUrl');
  });
  it('translates the existing sandbox variables only when no YAML exists', () => {
    vi.stubEnv('OPENMAIC_SANDBOX_PROVIDER', 'e2b-compatible');
    vi.stubEnv('OPENMAIC_SANDBOX_CONNECTION_ID', 'legacy');
    vi.stubEnv('OPENMAIC_SANDBOX_API_KEY', 'legacy-key');
    vi.stubEnv('OPENMAIC_SANDBOX_TEMPLATE', 'legacy-code');
    expect(loadDeploymentLayer()).toMatchObject({
      legacy: true,
      layer: {
        config: {
          sandbox: {
            enabled: true,
            connectionId: 'legacy',
            apiKey: 'legacy-key',
            template: 'legacy-code',
          },
        },
      },
    });
    writeFileSync(join(dir, 'openmaic.yml'), yaml);
    expect(loadDeploymentLayer().layer?.config.sandbox?.apiKey).toBe('deployment-secret');
    writeFileSync(join(dir, 'openmaic.yml'), 'slots:\n  video: null\n');
    expect(loadDeploymentLayer().layer?.config.sandbox).toBeUndefined();
  });
  it('fails startup on invalid legacy limits rather than accepting them until first use', () => {
    vi.stubEnv('OPENMAIC_SANDBOX_PROVIDER', 'e2b-compatible');
    vi.stubEnv('OPENMAIC_SANDBOX_CONNECTION_ID', 'legacy');
    vi.stubEnv('OPENMAIC_SANDBOX_API_KEY', 'legacy-key');
    vi.stubEnv('OPENMAIC_SANDBOX_TEMPLATE', 'legacy-code');
    vi.stubEnv('OPENMAIC_SANDBOX_LIFETIME_MS', '1.5');
    expect(() => loadDeploymentLayer()).toThrow('sandbox.lifetimeMs');
  });
  it.each(['E2B_SANDBOX_URL', 'E2B_ACCESS_TOKEN'])(
    'rejects SDK redirect override %s at startup',
    (name) => {
      writeFileSync(join(dir, 'openmaic.yml'), yaml);
      vi.stubEnv(name, 'never-echo-this');
      expect(() => loadDeploymentLayer()).toThrow(name);
      try {
        loadDeploymentLayer();
      } catch (error) {
        expect(String(error)).not.toContain('never-echo-this');
      }
    },
  );
});

it('does not expose installation sandbox configuration through the learner model-settings view', () => {
  setDeploymentConfigForTests({
    layer: { source: 'deployment', config: parseModelConfig(yaml) },
    legacy: false,
    notices: [],
  });
  const view = JSON.stringify(modelSettingsView(null));
  expect(view).not.toContain('deployment-secret');
  expect(view).not.toContain('sandbox');
  expect(view).not.toContain('api.e2b.dev');
});
