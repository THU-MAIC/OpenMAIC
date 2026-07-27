import type { DocumentStore } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppScene } from '@/lib/types/stage';

import type { AppStage } from '@/lib/document-store/persistence-types';

function stubStore(): DocumentStore<AppScene, AppStage> {
  return {} as DocumentStore<AppScene, AppStage>;
}

describe('configureDocumentStorage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('uses the configured factory and supplies the app validators', async () => {
    const injected = stubStore();
    const factory = vi.fn(() => injected);
    const { configureDocumentStorage, getDocumentStore, validateAppScene, validateAppStage } =
      await import('@/lib/document-store');
    configureDocumentStorage({ store: factory });

    expect(factory).not.toHaveBeenCalled();
    const resolved = getDocumentStore();
    expect(resolved).not.toBe(injected);
    expect(getDocumentStore()).toBe(resolved);
    expect(factory).toHaveBeenCalledExactlyOnceWith({
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  });

  it('stays sealed after document storage resolution starts', async () => {
    const injected = stubStore();
    const { configureDocumentStorage, getDocumentStore } = await import('@/lib/document-store');
    configureDocumentStorage({ store: injected });
    getDocumentStore();

    expect(() => configureDocumentStorage({ store: stubStore() })).toThrow(
      'configureDocumentStorage must be called at module-level bootstrap, before any document consumer runs — a component effect is too late.',
    );
  });

  it('delegates own methods with the configured store as receiver', async () => {
    const states = new WeakMap<object, string>();
    const injected = {
      loadDocument() {
        return Promise.resolve(states.get(this) ?? null);
      },
    } as unknown as DocumentStore<AppScene, AppStage>;
    states.set(injected, 'receiver-ok');
    const { configureDocumentStorage, getDocumentStore } = await import('@/lib/document-store');
    configureDocumentStorage({ store: injected });

    const resolved = getDocumentStore();
    await expect(resolved.loadDocument('stage-1')).resolves.toBe('receiver-ok');

    const override = vi.spyOn(resolved, 'loadDocument').mockResolvedValue(null);
    await expect(resolved.loadDocument('stage-1')).resolves.toBeNull();
    expect(override).toHaveBeenCalledWith('stage-1');
  });

  it('wraps a frozen configured store without violating Proxy invariants', async () => {
    const noOp = async () => undefined;
    const injected = Object.freeze({
      saveDocument: noOp,
      loadDocument: async () => null,
      listDocuments: async () => [],
      deleteDocument: noOp,
      putStage: noOp,
      putScene: noOp,
      getScene: async () => null,
      deleteScene: noOp,
    }) as unknown as DocumentStore<AppScene, AppStage>;
    const { configureDocumentStorage, getDocumentStore } = await import('@/lib/document-store');
    configureDocumentStorage({ store: injected });

    await expect(getDocumentStore().loadDocument('stage-1')).resolves.toBeNull();
  });

  it('resetDocumentStorageForTests clears configuration and the latched store', async () => {
    const first = stubStore();
    const second = stubStore();
    const {
      configureDocumentStorage,
      getDocumentStore,
      isDocumentStorageConfigured,
      resetDocumentStorageForTests,
    } = await import('@/lib/document-store');

    configureDocumentStorage({ store: first });
    const firstResolved = getDocumentStore();
    expect(firstResolved).not.toBe(first);
    expect(isDocumentStorageConfigured()).toBe(true);

    resetDocumentStorageForTests();
    expect(isDocumentStorageConfigured()).toBe(false);
    configureDocumentStorage({ store: second });
    const secondResolved = getDocumentStore();
    expect(secondResolved).not.toBe(second);
    expect(secondResolved).not.toBe(firstResolved);
  });

  it('resetDocumentStorageForTests clears wrapped store method overrides', async () => {
    const injected = {
      loadDocument: vi.fn().mockResolvedValue('underlying'),
    } as unknown as DocumentStore<AppScene, AppStage>;
    const { configureDocumentStorage, getDocumentStore, resetDocumentStorageForTests } =
      await import('@/lib/document-store');

    configureDocumentStorage({ store: injected });
    const firstResolved = getDocumentStore();
    vi.spyOn(firstResolved, 'loadDocument').mockResolvedValue('overridden' as never);
    await expect(firstResolved.loadDocument('stage-1')).resolves.toBe('overridden');

    resetDocumentStorageForTests();
    configureDocumentStorage({ store: injected });
    const secondResolved = getDocumentStore();

    expect(secondResolved).not.toBe(firstResolved);
    await expect(secondResolved.loadDocument('stage-1')).resolves.toBe('underlying');
  });
});
