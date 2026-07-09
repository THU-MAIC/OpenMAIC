import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

import { getLearnerKey, LEARNER_KEY_KV_KEY } from '@/lib/runtime/learner-key';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
}

describe('getLearnerKey', () => {
  it('mints an anon key once and returns the same key afterwards', async () => {
    const kv = new BrowserKVStore({ storage: memoryStorage() });
    const first = await getLearnerKey(kv);
    expect(first).toMatch(/^anon:[0-9a-f-]{36}$/);
    await expect(getLearnerKey(kv)).resolves.toBe(first);
  });

  it('persists under the device scope, never the account scope', async () => {
    const storage = memoryStorage();
    const kv = new BrowserKVStore({ storage });
    const key = await getLearnerKey(kv);

    // BrowserKVStore encodes the scope in the storage key: `maic:<scope>:<key>`
    const entries = [...Array(storage.length).keys()].map((i) => storage.key(i));
    const deviceEntry = entries.find((k) => k?.includes(':device:'));
    expect(deviceEntry).toContain(LEARNER_KEY_KV_KEY);
    expect(storage.getItem(deviceEntry!)).toContain(key);
    expect(entries.find((k) => k?.includes(':account:'))).toBeUndefined();
  });

  it('two different devices (stores) mint different keys', async () => {
    const a = await getLearnerKey(new BrowserKVStore({ storage: memoryStorage() }));
    const b = await getLearnerKey(new BrowserKVStore({ storage: memoryStorage() }));
    expect(a).not.toBe(b);
  });

  it('concurrent calls on one device converge on a single key', async () => {
    const kv = new BrowserKVStore({ storage: memoryStorage() });
    const keys = await Promise.all([getLearnerKey(kv), getLearnerKey(kv), getLearnerKey(kv)]);
    expect(new Set(keys).size).toBe(1);
    // and later calls agree with what actually persisted
    await expect(getLearnerKey(kv)).resolves.toBe(keys[0]);
  });

  it('returns the persisted winner when another tab wins the write race', async () => {
    const winner = 'anon:11111111-1111-4111-8111-111111111111';
    const m = new Map<string, string>();
    // Simulate a cross-tab race: whatever this caller persists, the storage
    // ends up holding another tab's later write (last write wins). The caller
    // must converge on the stored value, never keep an orphaned local mint.
    const storage = {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k: string) => m.get(k) ?? null,
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => void m.delete(k),
      setItem: (k: string) => void m.set(k, JSON.stringify(winner)),
    } as Storage;

    await expect(getLearnerKey(new BrowserKVStore({ storage }))).resolves.toBe(winner);
  });
});

describe('getLearnerKey cross-tab locking', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mints inside a Web Lock when navigator.locks is available', async () => {
    // A serializing fake: grants run strictly one at a time, like the real
    // Web Locks API does for a single lock name.
    const requestedNames: string[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const locks = {
      request: (name: string, cb: () => Promise<unknown>) => {
        requestedNames.push(name);
        const granted = chain.then(() => cb());
        chain = granted.catch(() => undefined);
        return granted;
      },
    };
    vi.stubGlobal('navigator', { locks });

    const kv = new BrowserKVStore({ storage: memoryStorage() });
    const keys = await Promise.all([getLearnerKey(kv), getLearnerKey(kv), getLearnerKey(kv)]);
    expect(new Set(keys).size).toBe(1);
    // every miss went through the lock, under one shared name
    expect(requestedNames.length).toBe(3);
    expect(new Set(requestedNames).size).toBe(1);
  });

  it('falls back to read-after-write when navigator.locks is unavailable', async () => {
    vi.stubGlobal('navigator', {}); // e.g. an old browser: no Web Locks
    const kv = new BrowserKVStore({ storage: memoryStorage() });
    const key = await getLearnerKey(kv);
    expect(key).toMatch(/^anon:[0-9a-f-]{36}$/);
    await expect(getLearnerKey(kv)).resolves.toBe(key);
  });
});
