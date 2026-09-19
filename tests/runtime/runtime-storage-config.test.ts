import type { KVStore, RuntimeStore } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function stubStore(deleteStageRuntime = vi.fn().mockResolvedValue(undefined)): RuntimeStore {
  return { deleteStageRuntime } as unknown as RuntimeStore;
}

describe('configureRuntimeStorage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('retains the lazy BrowserRuntimeStore singleton by default', async () => {
    const { BrowserRuntimeStore } = await import('@openmaic/storage');
    const { getRuntimeStore } = await import('@/lib/runtime/store');

    const first = getRuntimeStore();

    expect(first).toBeInstanceOf(BrowserRuntimeStore);
    expect(getRuntimeStore()).toBe(first);
  });

  it('routes an existing consumer through an injected RuntimeStore', async () => {
    vi.stubGlobal('indexedDB', {
      databases: vi.fn().mockResolvedValue([]),
    });
    const deleteStageRuntime = vi.fn().mockResolvedValue(undefined);
    const injected = stubStore(deleteStageRuntime);
    const { configureRuntimeStorage, deleteStageRuntimeSafely, getRuntimeStore } =
      await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: injected });

    await deleteStageRuntimeSafely('stage-injected');

    expect(getRuntimeStore()).toBe(injected);
    expect(deleteStageRuntime).toHaveBeenCalledExactlyOnceWith('stage-injected');
  });

  it('evaluates a store factory lazily and only once', async () => {
    const injected = stubStore();
    const factory = vi.fn(() => injected);
    const { configureRuntimeStorage, getRuntimeStore } = await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: factory });

    expect(factory).not.toHaveBeenCalled();
    expect(getRuntimeStore()).toBe(injected);
    expect(getRuntimeStore()).toBe(injected);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('retries a store factory after it throws, then latches the first success', async () => {
    const injected = stubStore();
    const factory = vi
      .fn<() => RuntimeStore>()
      .mockImplementationOnce(() => {
        throw new Error('backend is not ready');
      })
      .mockReturnValue(injected);
    const { configureRuntimeStorage, getRuntimeStore } = await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: factory });

    expect(() => getRuntimeStore()).toThrow('backend is not ready');
    expect(getRuntimeStore()).toBe(injected);
    expect(getRuntimeStore()).toBe(injected);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('throws when configured after runtime storage has been used', async () => {
    const { configureRuntimeStorage, getRuntimeStore } = await import('@/lib/runtime/store');
    getRuntimeStore();

    expect(() => configureRuntimeStorage({ store: stubStore() })).toThrow(
      'configureRuntimeStorage must be called at module-level bootstrap, before any runtime consumer runs — a component effect is too late.',
    );
  });

  it('explains that configuration stays sealed after a factory resolution failure', async () => {
    const factory = vi.fn((): RuntimeStore => {
      throw new Error('factory failed');
    });
    const { configureRuntimeStorage, getRuntimeStore } = await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: factory });
    expect(() => getRuntimeStore()).toThrow('factory failed');

    expect(() => configureRuntimeStorage({ store: stubStore() })).toThrow(
      'configuration remains sealed even if resolution failed. Retry the runtime consumer to retry resolution.',
    );
  });

  it('throws on repeated configuration before first use', async () => {
    const { configureRuntimeStorage } = await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: stubStore() });

    expect(() => configureRuntimeStorage({ learnerKey: () => 'account:second' })).toThrow(
      'Runtime storage has already been configured',
    );
  });

  it('gives an explicit KV store priority over the configured learnerKey provider', async () => {
    const learnerKey = vi.fn(() => 'account:user-42');
    const kv = {
      get: vi.fn().mockResolvedValue('anon:explicit-kv'),
    } as unknown as KVStore;
    const { configureRuntimeStorage } = await import('@/lib/runtime/store');
    const { getLearnerKey } = await import('@/lib/runtime/learner-key');
    configureRuntimeStorage({ learnerKey });

    await expect(getLearnerKey(kv)).resolves.toBe('anon:explicit-kv');
    expect(kv.get).toHaveBeenCalledExactlyOnceWith('runtime.learnerKey', 'device');
    expect(learnerKey).not.toHaveBeenCalled();
  });

  it('deduplicates configured learnerKey resolution and latches its first value', async () => {
    let resolveProvider!: (value: string) => void;
    const learnerKey = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const { configureRuntimeStorage } = await import('@/lib/runtime/store');
    const { getLearnerKey } = await import('@/lib/runtime/learner-key');
    configureRuntimeStorage({ learnerKey });

    const first = getLearnerKey();
    const concurrent = getLearnerKey();
    await Promise.resolve();
    expect(learnerKey).toHaveBeenCalledOnce();
    resolveProvider('account:first');
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      'account:first',
      'account:first',
    ]);
    await expect(getLearnerKey()).resolves.toBe('account:first');
    expect(learnerKey).toHaveBeenCalledOnce();
  });

  it('reports and resets bootstrap configuration state for tests', async () => {
    const { configureRuntimeStorage, isRuntimeStorageConfigured, resetRuntimeStorageForTests } =
      await import('@/lib/runtime/store');

    expect(isRuntimeStorageConfigured()).toBe(false);
    configureRuntimeStorage({ learnerKey: () => 'account:test' });
    expect(isRuntimeStorageConfigured()).toBe(true);
    resetRuntimeStorageForTests();
    expect(isRuntimeStorageConfigured()).toBe(false);
    expect(() => configureRuntimeStorage({ store: stubStore() })).not.toThrow();
  });
});

describe('configuration snapshot and full reset', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('mutating the options object after configure has no effect', async () => {
    const first = stubStore();
    const second = stubStore();
    const { configureRuntimeStorage, getRuntimeStore } = await import('@/lib/runtime/store');
    const options = { store: first };
    configureRuntimeStorage(options);
    options.store = second;

    expect(getRuntimeStore()).toBe(first);
  });

  it('resetRuntimeStorageForTests clears the latched store singleton', async () => {
    const first = stubStore();
    const second = stubStore();
    const { configureRuntimeStorage, getRuntimeStore, resetRuntimeStorageForTests } =
      await import('@/lib/runtime/store');
    configureRuntimeStorage({ store: first });
    expect(getRuntimeStore()).toBe(first);

    resetRuntimeStorageForTests();
    configureRuntimeStorage({ store: second });

    expect(getRuntimeStore()).toBe(second);
  });
});
