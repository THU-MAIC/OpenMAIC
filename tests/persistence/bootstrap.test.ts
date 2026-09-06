import { beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  } as Storage;
}

describe('persistence client bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('leaves all sealed storage seams untouched when the flag is unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '');

    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');
    const assets = await import('@/lib/media/asset-pool-config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
  });

  it('configures the runtime, document and asset HTTP stores together', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE_TOKEN', 'test-dev-token');
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', memoryStorage());

    const { HttpAssetStore, HttpDocumentStore } = await import('@openmaic/storage');
    const { HttpRuntimeStore } = await import('@openmaic/storage/runtime/http');
    // Importing any seam must structurally run bootstrap before the seam can
    // resolve its default store.
    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');
    const assets = await import('@/lib/media/asset-pool-config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(true);
    expect(documents.isDocumentStorageConfigured()).toBe(true);
    expect(assets.isAssetPoolStorageConfigured()).toBe(true);

    const runtimeStore = runtime.getRuntimeStore();
    const documentStore = documents.getDocumentStore();
    expect(runtimeStore).toBeInstanceOf(HttpRuntimeStore);
    expect(documentStore).toBeInstanceOf(HttpDocumentStore);

    const documentInternals = documentStore as unknown as {
      validateSceneFn: unknown;
      validateStageFn: unknown;
    };
    expect(documentInternals.validateSceneFn).toBe(documents.validateAppScene);
    expect(documentInternals.validateStageFn).toBe(documents.validateAppStage);

    const headersOf = async (store: unknown, path: string) =>
      new Headers(
        await (
          store as {
            headersHook: (context: { method: string; path: string }) => Promise<HeadersInit>;
          }
        ).headersHook({ method: 'GET', path }),
      );

    const runtimeHeaders = await headersOf(runtimeStore, '/runtime/sessions/example');
    expect(runtimeHeaders.get('authorization')).toBe('Bearer test-dev-token');
    expect(runtimeHeaders.get('x-learner-key')).toMatch(/^anon:/);

    // The asset pool is a server-backed pool over the same endpoint, carrying
    // the same credentials the document store carries. Anything less and the
    // written-back reference would resolve for nobody.
    const assetStore = assets.resolveConfiguredAssetPoolStore();
    expect(assetStore).toBeInstanceOf(HttpAssetStore);
    expect(assets.isAssetPoolServerBacked()).toBe(true);
    expect((assetStore as unknown as { baseUrl: string }).baseUrl).toBe('/api/persistence');
    const assetHeaders = await headersOf(assetStore, '/assets');
    expect(assetHeaders.get('authorization')).toBe('Bearer test-dev-token');
    expect(assetHeaders.get('x-learner-key')).toBe(runtimeHeaders.get('x-learner-key'));

    runtime.resetRuntimeStorageForTests();
    documents.resetDocumentStorageForTests();
    assets.resetAssetPoolStorageForTests();
    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
  });

  it('leaves the asset pool on its browser default in browser-only mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '');
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', memoryStorage());

    const assets = await import('@/lib/media/asset-pool-config');
    await import('@/lib/document-store');

    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
    expect(assets.resolveConfiguredAssetPoolStore()).toBeUndefined();
    expect(assets.isAssetPoolServerBacked()).toBe(false);
  });

  it('does not run client configuration during server module evaluation', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');

    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store');
    const assets = await import('@/lib/media/asset-pool-config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
  });

  it('preflights both configured seams so a failure cannot partially configure bootstrap', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubGlobal('window', {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const documents = await import('@/lib/document-store/config');
    documents.configureDocumentStorage({});

    const runtime = await import('@/lib/runtime/store');
    const assets = await import('@/lib/media/asset-pool-config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(true);
    expect(assets.isAssetPoolStorageConfigured()).toBe(false);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]?.[0]).toContain('FATAL');
  });

  it('preflights the asset seam too, so a sealed pool cannot half-configure bootstrap', async () => {
    vi.stubEnv('NEXT_PUBLIC_PERSISTENCE', '1');
    vi.stubGlobal('window', {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const assets = await import('@/lib/media/asset-pool-config');
    assets.configureAssetPoolStorage({});

    const runtime = await import('@/lib/runtime/store');
    const documents = await import('@/lib/document-store/config');

    expect(runtime.isRuntimeStorageConfigured()).toBe(false);
    expect(documents.isDocumentStorageConfigured()).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    for (const call of errorSpy.mock.calls) expect(String(call[0])).toContain('FATAL');
  });
});
