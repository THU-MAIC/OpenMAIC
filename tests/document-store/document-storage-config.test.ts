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
    expect(getDocumentStore()).toBe(injected);
    expect(getDocumentStore()).toBe(injected);
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
    expect(getDocumentStore()).toBe(first);
    expect(isDocumentStorageConfigured()).toBe(true);

    resetDocumentStorageForTests();
    expect(isDocumentStorageConfigured()).toBe(false);
    configureDocumentStorage({ store: second });
    expect(getDocumentStore()).toBe(second);
  });
});
