import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configureAssetByteStore,
  configurePersistenceHooks,
  getAssetByteStoreRegistration,
  getPersistenceHooks,
  resetPersistenceHooksForTests,
  validatePersistenceHooksConfiguration,
} from '@/lib/server/persistence-hooks/registry';
import type { AssetByteStoreRegistration } from '@/lib/server/persistence-hooks/types';

// register() is exercised for its hook validation only.
vi.mock('@/lib/persistence/asset-quota', () => ({ resolveAssetQuotaBytes: vi.fn() }));
vi.mock('@/lib/persistence/asset-pending-ttl', () => ({ resolveAssetPendingTtlMs: vi.fn() }));
vi.mock('@/lib/persistence/asset-collector-schedule', () => ({
  startAssetCollectorSchedule: vi.fn(),
}));
vi.mock('@/lib/server/config-validation', () => ({ validateServerConfig: vi.fn() }));
vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeConfigured: () => false }));

const store: AssetByteStoreRegistration = {
  name: 'object-store',
  create: () => ({
    write: async () => {},
    read: async () => null,
    delete: async () => {},
    writesOutsideRegistryDatabase: true,
  }),
};

beforeEach(() => {
  resetPersistenceHooksForTests();
  vi.stubEnv('ASSET_S3_BUCKET', '');
  vi.stubEnv('ASSET_BYTE_EGRESS', '');
});

afterEach(() => {
  resetPersistenceHooksForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('configurePersistenceHooks', () => {
  it('has no hooks by default', () => {
    const hooks = getPersistenceHooks();
    expect(hooks.authorizeCreate).toBeUndefined();
    expect(hooks.onCreate).toBeUndefined();
    expect(hooks.library).toBeUndefined();
    expect(hooks.beforeAssetAllocate).toBeUndefined();
  });

  it('registers once and is read back', () => {
    const onCreate = async () => {};
    configurePersistenceHooks({ name: 'host', onCreate });
    expect(getPersistenceHooks().onCreate).toBe(onCreate);
    expect(() => configurePersistenceHooks({ name: 'again' })).toThrow(/already configured/);
  });

  it('is sealed by the first read', () => {
    getPersistenceHooks();
    expect(() => configurePersistenceHooks({ name: 'late' })).toThrow(/after persistence started/);
  });

  it.each([
    ['no name', { onCreate: async () => {} }, /non-empty name/],
    ['a misspelled hook', { name: 'h', onCreated: async () => {} }, /"onCreated"/],
    ['a non-function hook', { name: 'h', authorizeCreate: true }, /authorizeCreate/],
    ['a non-function upload hook', { name: 'h', beforeAssetAllocate: 1 }, /beforeAssetAllocate/],
    ['a library without list', { name: 'h', library: { name: 'l' } }, /library/],
  ])('refuses %s', (_label, hooks, message) => {
    expect(() => configurePersistenceHooks(hooks as never)).toThrow(message);
    // A refused registration leaves the slot free.
    configurePersistenceHooks({ name: 'valid' });
  });
});

describe('configureAssetByteStore', () => {
  it('is the built-in choice by default and registers once', () => {
    expect(getAssetByteStoreRegistration()).toBeUndefined();
    resetPersistenceHooksForTests();
    configureAssetByteStore(store);
    expect(getAssetByteStoreRegistration()?.name).toBe('object-store');
    expect(() => configureAssetByteStore(store)).toThrow(/already configured/);
  });

  it('is sealed by the first byte store built', () => {
    getAssetByteStoreRegistration();
    expect(() => configureAssetByteStore(store)).toThrow(/after an asset byte store was built/);
  });

  it('refuses a malformed registration', () => {
    expect(() => configureAssetByteStore({ name: 'x' } as never)).toThrow(/expects/);
    expect(() => configureAssetByteStore({ ...store, signsReadUrls: 'yes' } as never)).toThrow(
      /expects/,
    );
  });

  it('refuses to be combined with ASSET_S3_BUCKET', () => {
    vi.stubEnv('ASSET_S3_BUCKET', 'asset-bucket');
    expect(() => configureAssetByteStore(store)).toThrow(/ASSET_S3_BUCKET/);
  });
});

describe('boot validation', () => {
  it('accepts the built-in layers under redirect egress, as before', () => {
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    expect(() => validatePersistenceHooksConfiguration()).not.toThrow();
  });

  it('refuses redirect egress for a host store that does not sign', () => {
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    configureAssetByteStore(store);
    expect(() => validatePersistenceHooksConfiguration()).toThrow(/signsReadUrls/);
  });

  it('accepts redirect egress for a host store that signs, and direct egress for any', () => {
    configureAssetByteStore({ ...store, signsReadUrls: true });
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    expect(() => validatePersistenceHooksConfiguration()).not.toThrow();
    vi.stubEnv('ASSET_BYTE_EGRESS', 'direct');
    expect(() => validatePersistenceHooksConfiguration()).not.toThrow();
  });

  it('refuses ASSET_S3_BUCKET set beside a registered store', () => {
    configureAssetByteStore(store);
    vi.stubEnv('ASSET_S3_BUCKET', 'asset-bucket');
    expect(() => validatePersistenceHooksConfiguration()).toThrow(/ASSET_S3_BUCKET/);
  });

  it('fails the instrumentation register() hook, before the server serves a request', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('ACCESS_CODE', 'demo-code-that-is-long-enough');
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    vi.stubEnv('OWNER_AUTHENTICATOR', '');
    vi.stubEnv('ASSET_BYTE_EGRESS', 'redirect');
    configureAssetByteStore(store);
    const { register } = await import('@/instrumentation');

    await expect(register()).rejects.toThrow(/ASSET_BYTE_EGRESS=redirect requires/);
    // Validation does not seal: the registration is still only configured.
    resetPersistenceHooksForTests();
  });
});

describe('client boundary', () => {
  const ROOT = join(__dirname, '..', '..', '..');
  const SERVER_ONLY = /from\s+['"]@\/lib\/server\/(?:persistence-hooks|identity)(?:\/[^'"]*)?['"]/;

  function clientModules(dir: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) found.push(...clientModules(path));
      else if (/\.(ts|tsx)$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        if (/^\s*['"]use client['"]/.test(text)) found.push(path);
      }
    }
    return found;
  }

  it('keeps the hook and identity registries out of client modules', () => {
    const modules = ['app', 'components', 'lib'].flatMap((dir) => clientModules(join(ROOT, dir)));
    expect(modules.length).toBeGreaterThan(10);
    const offenders = modules
      .filter((path) => SERVER_ONLY.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });
});
