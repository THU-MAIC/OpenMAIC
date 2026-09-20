/**
 * Which backend the persist seam BINDS — not how it behaves once bound.
 *
 * The seam's async-storage state machine already has its own suite
 * (`kv-persist.test.ts`), which injects a backend. What is new here is the
 * choice: a deployment with server-backed persistence must route the `account`
 * scope over the network, and a local-only deployment must not reach the
 * network at all. Both are wiring facts, invisible to the state machine.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

class MemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', {} as Window & typeof globalThis);
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('which KV backend the persist seam binds', () => {
  it('never reaches the network on a local-only deployment', async () => {
    vi.doMock('@/lib/persistence/enabled', () => ({
      isBrowserPersistenceEnabled: () => false,
      getPersistenceRequestHeaders: async () => ({}),
    }));
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { createKVPersistStorage } = await import('@/lib/store/kv-persist');
    const storage = createKVPersistStorage('account', {});
    await storage.getItem('settings-storage');
    await flush();
    await storage.setItem('settings-storage', { state: { a: 1 }, version: 4 });
    await flush();

    expect(fetchSpy, 'local-only deployment reached the network').not.toHaveBeenCalled();
    expect(localStorage.length, 'a local-only write never reached local storage').toBeGreaterThan(0);
  });

  it('routes an account write to the server store when persistence is on', async () => {
    vi.doMock('@/lib/persistence/enabled', () => ({
      isBrowserPersistenceEnabled: () => true,
      getPersistenceRequestHeaders: async () => ({ 'x-learner-key': 'k' }),
    }));
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        // The hydrating read finds nothing; the contract says that is a 404.
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(
            JSON.stringify({ error: { code: 'KEY_NOT_FOUND', message: 'no kv entry' } }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(null, { status: 204 });
      }),
    );

    const { createKVPersistStorage } = await import('@/lib/store/kv-persist');
    const storage = createKVPersistStorage('account', {});
    await storage.getItem('settings-storage');
    await flush();
    await storage.setItem('settings-storage', { state: { a: 1 }, version: 4 });
    await flush();

    expect(calls, 'account write did not reach the server store').toContainEqual({
      url: '/api/persistence/kv/entries/settings-storage',
      method: 'PUT',
    });
  });

  it('keeps the device scope off the network even when persistence is on', async () => {
    vi.doMock('@/lib/persistence/enabled', () => ({
      isBrowserPersistenceEnabled: () => true,
      getPersistenceRequestHeaders: async () => ({}),
    }));
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(null, { status: 204 });
      }),
    );

    const { createKVPersistStorage } = await import('@/lib/store/kv-persist');
    const storage = createKVPersistStorage('device', {});
    await storage.getItem('layout');
    await flush();
    await storage.setItem('layout', { state: { b: 2 }, version: 1 });
    await flush();

    expect(calls, 'device scope crossed the network boundary').toEqual([]);
    expect(localStorage.length, 'the device scope never reached local storage').toBeGreaterThan(0);
  });
});
