import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const db = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  active: 0,
  queries: [] as string[],
}));
vi.mock('@/lib/persistence/server-provider', () => {
  const query = async (sql: string, args: unknown[] = []) => {
    db.queries.push(sql);
    if (sql.startsWith('SELECT config')) return { rows: db.row ? [db.row] : [] };
    if (sql.startsWith('SELECT count')) return { rows: [{ count: String(db.active) }] };
    if (sql.startsWith('INSERT INTO sandbox_settings'))
      db.row = {
        config: JSON.parse(String(args[0])),
        secret: JSON.parse(String(args[1])),
        revision: args[2],
      };
    return { rows: [] };
  };
  const p = {
    pool: { query },
    withTransaction: async (f: (tx: { query: typeof query }) => Promise<unknown>) => f({ query }),
  };
  return { getServerPersistenceProvider: async () => p };
});
vi.mock('@/lib/persistence/schema-bootstrap-lock', () => ({
  withSchemaBootstrapLock: async () => {},
}));
vi.mock('@/lib/server/sandbox/checkpoint-storage', () => ({
  CheckpointStorage: class {
    async available() {
      return true;
    }
  },
}));
import {
  assertSandboxSettingsAdmin,
  saveSandboxSettings,
  sandboxSettingsView,
  resolvedSandboxConfig,
  sandboxWorkspaceEnabled,
  assertSandboxSettingsRevision,
} from '@/lib/server/sandbox/settings';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import {
  sandboxConfigurationSchema,
  legacySandboxConfiguration,
} from '@/lib/sandbox/config-schema';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { resetOwnerAuthenticationForTests } from '@/lib/server/identity/registry';
import type { OwnerPrincipal } from '@/lib/server/identity';
const fields = {
  enabled: true,
  provider: 'e2b-compatible',
  connectionId: 'test',
  apiUrl: 'https://api.e2b.dev',
  domain: 'e2b.app',
  template: 'code',
  desktopTemplate: '',
  lifetimeMs: 300000,
  maxActive: 5,
  maxActivePerOwner: 1,
};
beforeEach(() => {
  setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
  db.row = undefined;
  db.active = 0;
  db.queries = [];
  vi.stubEnv('DATABASE_URL', 'test');
  vi.stubEnv('OWNER_SINGLE_USER_ID', undefined);
  vi.stubEnv('OPENMAIC_SECRET_KEY', 'test-instance-key-only');
  vi.stubEnv('OPENMAIC_SANDBOX_PROVIDER', '');
  vi.stubEnv('OPENMAIC_SANDBOX_API_KEY', '');
  vi.stubEnv('OWNER_SINGLE_USER', 'false');
  resetOwnerAuthenticationForTests();
});
afterEach(() => {
  setDeploymentConfigForTests();
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
});
describe('installation sandbox settings', () => {
  it('saves encrypted keys, returns no secret, and runtime and workspace use saved values without env provider', async () => {
    const view = await saveSandboxSettings({ revision: 0, fields, apiKey: 'test-key-unique' });
    expect(view).toMatchObject({ revision: 1, source: 'settings', keySet: true, configured: true });
    expect(JSON.stringify(view)).not.toContain('test-key-unique');
    expect(JSON.stringify(db.row)).not.toContain('test-key-unique');
    expect(db.row?.secret).toMatchObject({ v: 1 });
    expect(await resolvedSandboxConfig()).toMatchObject({
      apiKey: 'test-key-unique',
      settingsRevision: 1,
      template: 'code',
    });
    expect(await sandboxWorkspaceEnabled()).toBe(true);
    await saveSandboxSettings({ revision: 1, fields: { ...fields, lifetimeMs: 600000 } });
    expect(await resolvedSandboxConfig()).toMatchObject({
      apiKey: 'test-key-unique',
      lifetimeMs: 600000,
    });
  });
  it('reads env configuration and can adopt it without copying a secret into the browser', async () => {
    vi.stubEnv('OPENMAIC_SANDBOX_PROVIDER', 'e2b-compatible');
    vi.stubEnv('OPENMAIC_SANDBOX_CONNECTION_ID', 'test');
    vi.stubEnv('OPENMAIC_SANDBOX_TEMPLATE', 'code');
    vi.stubEnv('OPENMAIC_SANDBOX_API_KEY', 'env-secret');
    setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          sandbox: sandboxConfigurationSchema.parse(legacySandboxConfiguration(process.env)),
        },
      },
      legacy: true,
      notices: [],
    });
    const view = await sandboxSettingsView();
    expect(view).toMatchObject({ source: 'deployment', configured: true, keySet: true });
    expect(JSON.stringify(view)).not.toContain('env-secret');
    await saveSandboxSettings({ revision: 0, fields: view.fields });
    expect((await resolvedSandboxConfig()).apiKey).toBe('env-secret');
    expect(db.row?.secret).toBeNull();
    expect(db.row?.config).toEqual({});
  });
  it('keeps saved configuration authoritative when env differs and fails closed when disabled', async () => {
    await saveSandboxSettings({ revision: 0, fields, apiKey: 'saved-key' });
    vi.stubEnv('OPENMAIC_SANDBOX_API_KEY', 'different-key');
    vi.stubEnv('OPENMAIC_SANDBOX_PROVIDER', 'e2b-compatible');
    expect((await resolvedSandboxConfig()).apiKey).toBe('saved-key');
    await saveSandboxSettings({ revision: 1, fields: { ...fields, enabled: false } });
    await expect(resolvedSandboxConfig()).rejects.toMatchObject({ code: 'SANDBOX_DISABLED' });
    expect(await sandboxWorkspaceEnabled()).toBe(false);
  });
  it('refuses stale writes and stale allocation snapshots', async () => {
    await saveSandboxSettings({ revision: 0, fields, apiKey: 'key' });
    await expect(saveSandboxSettings({ revision: 0, fields })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      assertSandboxSettingsRevision((await getServerPersistenceProvider('test')).pool, 0),
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each([1, 5])('refuses any change while %i environments are outstanding', async (active) => {
    db.active = active;
    await expect(saveSandboxSettings({ revision: 0, fields, apiKey: 'key' })).rejects.toMatchObject(
      { status: 409 },
    );
    expect(db.row).toBeUndefined();
    expect(db.queries.some((q) => q.includes('openmaic.sandbox.capacity'))).toBe(true);
  });
  it('requires a fresh key before sending credentials to a changed endpoint or account', async () => {
    await saveSandboxSettings({ revision: 0, fields, apiKey: 'key' });
    for (const update of [
      { apiUrl: 'https://api.other.example' },
      { domain: 'other.example' },
      { connectionId: 'other' },
    ])
      await expect(
        saveSandboxSettings({ revision: 1, fields: { ...fields, ...update } }),
      ).rejects.toMatchObject({ status: 400 });
    await saveSandboxSettings({
      revision: 1,
      fields: { ...fields, apiUrl: 'https://api.other.example' },
      apiKey: 'new-key',
    });
    expect((await resolvedSandboxConfig()).apiKey).toBe('new-key');
  });
  it.each([
    { apiUrl: 'http://example.com' },
    { domain: 'bad/path' },
    { template: '' },
    { maxActive: 0 },
    { maxActivePerOwner: 6 },
    { provider: 'vendor-specific' },
    { lifetimeMs: 3600001 },
  ])('validates input %j', async (invalid) => {
    await expect(
      saveSandboxSettings({ revision: 0, fields: { ...fields, ...invalid }, apiKey: 'key' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.row).toBeUndefined();
  });
  it('reports unreadable keys and requires re-entry, never silently falls back to env', async () => {
    await saveSandboxSettings({ revision: 0, fields, apiKey: 'key' });
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'changed-instance-secret');
    vi.stubEnv('OPENMAIC_SANDBOX_API_KEY', 'fallback-key');
    expect(await sandboxSettingsView()).toMatchObject({
      keySet: true,
      keyUnreadable: true,
      configured: false,
    });
    await expect(resolvedSandboxConfig()).rejects.toMatchObject({ code: 'SANDBOX_KEY_UNREADABLE' });
    await expect(saveSandboxSettings({ revision: 1, fields })).rejects.toMatchObject({
      status: 400,
    });
    await saveSandboxSettings({ revision: 1, fields, apiKey: 'replacement' });
    expect((await resolvedSandboxConfig()).apiKey).toBe('replacement');
  });
  it('only allows the configured personal owner or verified administrator', () => {
    const p: OwnerPrincipal = {
      ownerId: 'admin',
      kind: 'user',
      assurance: 'verified',
      roles: new Set(['admin']),
    };
    expect(() => assertSandboxSettingsAdmin(p)).not.toThrow();
    for (const other of [
      { ...p, roles: new Set(['sandbox:use']) },
      { ...p, kind: 'anonymous' as const },
      { ...p, assurance: 'unverified-legacy' as const },
    ])
      expect(() => assertSandboxSettingsAdmin(other)).toThrow();
    vi.stubEnv('OWNER_SINGLE_USER', 'true');
    vi.stubEnv('OWNER_SINGLE_USER_ID', 'personal');
    resetOwnerAuthenticationForTests();
    expect(() =>
      assertSandboxSettingsAdmin({
        ...p,
        ownerId: 'personal',
        assurance: 'unverified-legacy',
        roles: new Set(),
      }),
    ).not.toThrow();
  });
});

function deploymentSettings(overrides = {}, lock?: 'all' | string[]) {
  setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: {
        sandbox: sandboxConfigurationSchema.parse({
          ...fields,
          apiKey: 'deployment-key',
          ...overrides,
        }),
        ...(lock ? { lock } : {}),
      },
    },
    legacy: false,
    notices: [],
  });
}
it.each(['all', ['sandbox']] as const)(
  'deployment lock %j ignores saved overrides and unreadable keys',
  async (lock) => {
    await saveSandboxSettings({ revision: 0, fields, apiKey: 'saved-key' });
    vi.stubEnv('OPENMAIC_SECRET_KEY', 'changed-instance-key');
    deploymentSettings(
      { template: 'deployment-code' },
      typeof lock === 'string' ? lock : [...lock],
    );
    expect(await sandboxSettingsView()).toMatchObject({
      locked: true,
      source: 'deployment',
      keyUnreadable: false,
      fields: { template: 'deployment-code' },
    });
    expect(await resolvedSandboxConfig()).toMatchObject({
      apiKey: 'deployment-key',
      template: 'deployment-code',
      settingsRevision: 0,
    });
    await expect(saveSandboxSettings({ revision: 1, fields })).rejects.toMatchObject({
      status: 403,
    });
    await expect(saveSandboxSettings({ revision: 1, reset: true })).rejects.toMatchObject({
      status: 403,
    });
    const q = (await getServerPersistenceProvider('test')).pool;
    await expect(assertSandboxSettingsRevision(q, 1)).rejects.toMatchObject({ status: 409 });
    await expect(assertSandboxSettingsRevision(q, 0)).resolves.toBeUndefined();
    deploymentSettings();
    await expect(resolvedSandboxConfig()).rejects.toMatchObject({ code: 'SANDBOX_KEY_UNREADABLE' });
  },
);
it('inherits unchanged deployment fields and rotated keys; reset removes overrides with a new revision', async () => {
  deploymentSettings();
  await saveSandboxSettings({ revision: 0, fields: { ...fields, lifetimeMs: 600000 } });
  expect(db.row?.config).toEqual({ lifetimeMs: 600000 });
  expect(db.row?.secret).toBeNull();
  deploymentSettings({ apiKey: 'rotated-deployment-key', template: 'new-template' });
  expect(await resolvedSandboxConfig()).toMatchObject({
    apiKey: 'rotated-deployment-key',
    template: 'new-template',
    lifetimeMs: 600000,
  });
  db.active = 1;
  await expect(saveSandboxSettings({ revision: 1, reset: true })).rejects.toMatchObject({
    status: 409,
  });
  db.active = 0;
  await expect(saveSandboxSettings({ revision: 0, reset: true })).rejects.toMatchObject({
    status: 409,
  });
  const reset = await saveSandboxSettings({ revision: 1, reset: true });
  expect(reset).toMatchObject({
    revision: 2,
    source: 'deployment',
    hasOverrides: false,
    fields: { lifetimeMs: 300000 },
  });
  expect(db.row?.secret).toBeNull();
});
it('pins a web key to its account and endpoints across deployment changes', async () => {
  deploymentSettings();
  await saveSandboxSettings({ revision: 0, fields, apiKey: 'web-key' });
  deploymentSettings({
    apiUrl: 'https://new.example.org',
    domain: 'new.example.org',
    connectionId: 'new',
  });
  expect(await resolvedSandboxConfig()).toMatchObject({
    apiKey: 'web-key',
    apiUrl: fields.apiUrl,
    domain: fields.domain,
    connectionId: fields.connectionId,
  });
});
it('keeps a disable override that differs from the deployment default', async () => {
  deploymentSettings();
  await saveSandboxSettings({ revision: 0, fields, apiKey: 'web-key' });
  await saveSandboxSettings({ revision: 1, fields: { ...fields, enabled: false } });
  deploymentSettings();
  expect(await sandboxWorkspaceEnabled()).toBe(false);
});
it('restores one field to deployment inheritance without clearing other overrides', async () => {
  deploymentSettings();
  await saveSandboxSettings({
    revision: 0,
    fields: { ...fields, lifetimeMs: 600000, template: 'web-template' },
  });
  await saveSandboxSettings({ revision: 1, fields: { ...fields, lifetimeMs: 600000 } });
  expect(db.row?.config).toEqual({ lifetimeMs: 600000 });
  deploymentSettings({ template: 'updated-deployment-template', lifetimeMs: 900000 });
  expect(await resolvedSandboxConfig()).toMatchObject({
    template: 'updated-deployment-template',
    lifetimeMs: 600000,
  });
});
it('restores enabled to deployment inheritance when saved at its default value', async () => {
  deploymentSettings({ enabled: false });
  await saveSandboxSettings({ revision: 0, fields });
  await saveSandboxSettings({ revision: 1, fields: { ...fields, enabled: false } });
  expect(db.row?.config).toEqual({});
  expect(await sandboxWorkspaceEnabled()).toBe(false);
  deploymentSettings();
  expect(await sandboxWorkspaceEnabled()).toBe(true);
});
it('lock all with no sandbox section keeps the installation disabled', async () => {
  await saveSandboxSettings({ revision: 0, fields, apiKey: 'web-key' });
  setDeploymentConfigForTests({
    layer: { source: 'deployment', config: { lock: 'all' } },
    legacy: false,
    notices: [],
  });
  expect(await sandboxWorkspaceEnabled()).toBe(false);
  expect(await sandboxSettingsView()).toMatchObject({
    locked: true,
    configured: false,
    keySet: false,
  });
  await expect(resolvedSandboxConfig()).rejects.toMatchObject({ code: 'SANDBOX_DISABLED' });
});

it('never inherits a later deployment key into an earlier keyless endpoint override', async () => {
  await saveSandboxSettings({
    revision: 0,
    fields: { ...fields, enabled: false, apiUrl: 'https://other.example.org' },
  });
  deploymentSettings();
  const view = await sandboxSettingsView();
  expect(view).toMatchObject({ keySet: false, configured: false });
  await expect(resolvedSandboxConfig()).rejects.toMatchObject({ code: 'SANDBOX_CONFIG_INVALID' });
});
