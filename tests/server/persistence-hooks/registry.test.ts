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
    const onCreate = vi.fn(async () => {});
    configurePersistenceHooks({ name: 'host', onCreate });
    void getPersistenceHooks().onCreate!({} as never, {} as never, 'stage-1');
    expect(onCreate).toHaveBeenCalledWith({}, {}, 'stage-1');
    expect(() => configurePersistenceHooks({ name: 'again' })).toThrow(/already configured/);
  });

  it('keeps hooks defined on a class prototype, bound to their instance', async () => {
    class HostHooks {
      readonly name = 'class-host';
      readonly denied = 'retired';
      async authorizeCreate() {
        return { allow: false as const, message: this.denied };
      }
      async onCreate() {}
      async beforeAssetAllocate() {
        return new Response(this.denied, { status: 429 });
      }
    }
    class Library {
      readonly name = 'class-library';
      private readonly ids = ['stage-a'];
      async list() {
        return this.ids;
      }
    }
    const host = Object.assign(new HostHooks(), { library: new Library() });
    configurePersistenceHooks(host as never);

    const stored = getPersistenceHooks();
    expect(typeof stored.authorizeCreate).toBe('function');
    expect(typeof stored.onCreate).toBe('function');
    expect(typeof stored.beforeAssetAllocate).toBe('function');
    await expect(stored.authorizeCreate!({} as never, {} as never, 's')).resolves.toEqual({
      allow: false,
      message: 'retired',
    });
    await expect(stored.library!.list({} as never)).resolves.toEqual(['stage-a']);
    expect(stored.library!.name).toBe('class-library');
  });

  it('refuses a class instance with a misspelled hook, and suggests the hook', () => {
    class TypoHost {
      readonly name = 'typo-host';
      async authorizeCreat() {
        return { allow: false as const };
      }
    }
    expect(() => configurePersistenceHooks(new TypoHost() as never)).toThrow(
      /does not know the hook "authorizeCreat" \(did you mean "authorizeCreate"\?\)/,
    );
    // Nothing was registered: the slot is still free.
    configurePersistenceHooks({ name: 'valid' });
  });

  it('refuses a public helper method on a host class, with the guidance', () => {
    class HelperHost {
      readonly name = 'helper-host';
      async onCreate() {}
      lookupAccount() {
        return 'account';
      }
    }
    expect(() => configurePersistenceHooks(new HelperHost() as never)).toThrow(
      /"lookupAccount"\. A host class must keep helper methods private \(#method\)/,
    );
  });

  it('accepts a host class whose helpers are private, inherited hooks included', async () => {
    class BaseHost {
      async onCreate() {}
    }
    class PrivateHelperHost extends BaseHost {
      readonly name = 'private-host';
      readonly retiredOwners = new Set(['user:gone']);
      async authorizeCreate(_tx: unknown, actor: { ownerId: string }) {
        return this.#isRetired(actor.ownerId)
          ? { allow: false as const }
          : { allow: true as const };
      }
      #isRetired(ownerId: string) {
        return this.retiredOwners.has(ownerId);
      }
    }
    configurePersistenceHooks(new PrivateHelperHost() as never);
    const stored = getPersistenceHooks();
    expect(typeof stored.onCreate).toBe('function');
    await expect(
      stored.authorizeCreate!({} as never, { ownerId: 'user:gone' } as never, 's'),
    ).resolves.toEqual({ allow: false });
  });

  it('keeps a non-enumerable hook', () => {
    const hooks = { name: 'host' };
    const authorizeCreate = async () => ({ allow: true as const });
    Object.defineProperty(hooks, 'authorizeCreate', { value: authorizeCreate, enumerable: false });
    configurePersistenceHooks(hooks);
    expect(typeof getPersistenceHooks().authorizeCreate).toBe('function');
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

  it('keeps a byte store factory defined on a class prototype, bound to its instance', async () => {
    class ObjectStoreRegistration {
      readonly name = 'class-store';
      readonly signsReadUrls = true;
      private readonly bucket = 'objects';
      create() {
        return { bucket: this.bucket } as never;
      }
    }
    configureAssetByteStore(new ObjectStoreRegistration() as never);
    const stored = getAssetByteStoreRegistration()!;
    expect(stored.name).toBe('class-store');
    expect(stored.signsReadUrls).toBe(true);
    expect(await stored.create({ queryable: {} as never })).toEqual({ bucket: 'objects' });
  });

  it('refuses a byte store class with a misspelled factory or a public helper', () => {
    class TypoStore {
      readonly name = 'typo-store';
      create() {
        return {} as never;
      }
      craete() {
        return {} as never;
      }
    }
    expect(() => configureAssetByteStore(new TypoStore() as never)).toThrow(
      /does not know the key "craete" \(did you mean "create"\?\)/,
    );
    expect(() => configureAssetByteStore({ ...store, signsReadUrl: true } as never)).toThrow(
      /"signsReadUrl" \(did you mean "signsReadUrls"\?\)/,
    );
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
    // Validation does not seal: the slot still reports "already configured",
    // not "after a byte store was built", and the hooks are still open.
    expect(() => configureAssetByteStore(store)).toThrow(/already configured/);
    expect(() => configurePersistenceHooks({ name: 'late-but-before-use' })).not.toThrow();
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
