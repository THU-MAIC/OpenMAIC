/**
 * The zustand `persist` ↔ `KVStore` seam (lib/store/kv-persist.ts).
 *
 * Two things are load-bearing here and neither is visible from the store code:
 * the scope a store writes under, and the one-time adoption of the raw
 * `localStorage` entry zustand's default storage left behind. An adoption that
 * is not idempotent either duplicates state or resurrects a stale copy over a
 * newer one, so the repeat cases below are the point of this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserKVStore } from '@openmaic/storage';

import { createKVPersistStorage } from '@/lib/store/kv-persist';

/** In-memory `Storage`, isolated per test — nothing ambient is touched. */
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  [name: string]: unknown;
}

const NAME = 'settings-storage';

interface Prefs {
  nickname: string;
}

function harness() {
  const backing = new MemoryStorage();
  const legacy = new MemoryStorage();
  const kv = new BrowserKVStore({ storage: backing });
  return {
    backing,
    legacy,
    kv,
    storage: (scope: 'device' | 'account' = 'account') =>
      createKVPersistStorage<Prefs>(scope, { kv, legacyStorage: legacy }),
  };
}

function seedLegacy(legacy: Storage, state: unknown, version = 4) {
  legacy.setItem(NAME, JSON.stringify({ state, version }));
}

describe('createKVPersistStorage — round trip', () => {
  it('reads back what it wrote, envelope intact', async () => {
    const { storage } = harness();
    const persist = storage();
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });
    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('returns null for a store that was never written', async () => {
    const { storage } = harness();
    expect(await storage().getItem(NAME)).toBeNull();
  });

  it('removeItem clears the entry', async () => {
    const { storage } = harness();
    const persist = storage();
    await persist.setItem(NAME, { state: { nickname: 'Ada' } });
    await persist.removeItem(NAME);
    expect(await persist.getItem(NAME)).toBeNull();
  });
});

describe('createKVPersistStorage — scope', () => {
  it('writes under the scope it was given, and only that scope', async () => {
    const { kv, storage } = harness();
    await storage('device').setItem(NAME, { state: { nickname: 'Ada' } });

    expect(await kv.get(NAME, 'device')).toEqual({ state: { nickname: 'Ada' } });
    expect(await kv.get(NAME, 'account')).toBeNull();
  });

  it('does not read across scopes', async () => {
    const { kv, storage } = harness();
    await kv.set(NAME, { state: { nickname: 'Ada' } }, 'account');

    // Nothing was written to `device`, and the account value must not leak into
    // it — `device` data is defined as never leaving the machine, so the two
    // scopes have to stay disjoint even on a shared backend.
    expect(await storage('device').getItem(NAME)).toBeNull();
  });
});

describe('createKVPersistStorage — legacy localStorage adoption', () => {
  it('adopts the raw entry on first read and returns it', async () => {
    const { legacy, storage } = harness();
    seedLegacy(legacy, { nickname: 'Ada' });

    expect(await storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('moves the entry into the KV scope rather than copying it', async () => {
    const { kv, legacy, storage } = harness();
    seedLegacy(legacy, { nickname: 'Ada' });

    await storage().getItem(NAME);

    expect(await kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    // Not orphaned, and not left behind to be re-adopted later.
    expect(legacy.getItem(NAME)).toBeNull();
  });

  it('adopts into whichever scope the store declared', async () => {
    const { kv, legacy, storage } = harness();
    seedLegacy(legacy, { nickname: 'Ada' });

    await storage('device').getItem(NAME);

    expect(await kv.get(NAME, 'device')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    expect(await kv.get(NAME, 'account')).toBeNull();
  });

  it('is idempotent — repeated reads neither duplicate nor re-migrate', async () => {
    const { kv, legacy, storage } = harness();
    seedLegacy(legacy, { nickname: 'Ada' });
    const persist = storage();

    const first = await persist.getItem(NAME);
    const second = await persist.getItem(NAME);
    const third = await persist.getItem(NAME);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(legacy.getItem(NAME)).toBeNull();
    expect(await kv.get(NAME, 'account')).toEqual(first);
  });

  it('survives a fresh storage instance, the way a page reload sees it', async () => {
    const { legacy, storage } = harness();
    seedLegacy(legacy, { nickname: 'Ada' });

    await storage().getItem(NAME);
    // A reload builds a new adapter over the same backends.
    expect(await storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('keeps the KV value when a stale raw entry reappears, and drops the stale one', async () => {
    const { kv, legacy, storage } = harness();
    const persist = storage();
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });

    // An older tab (or a re-run seed) writes the pre-cutover key again. KV is
    // authoritative once it holds the entry, otherwise a stale copy could roll
    // back newer state on every load.
    seedLegacy(legacy, { nickname: 'stale' });

    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    expect(legacy.getItem(NAME)).toBeNull();
    expect(await kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('removeItem clears both homes so nothing can be re-adopted', async () => {
    const { legacy, storage } = harness();
    const persist = storage();
    await persist.setItem(NAME, { state: { nickname: 'Ada' } });
    seedLegacy(legacy, { nickname: 'stale' });

    await persist.removeItem(NAME);

    expect(legacy.getItem(NAME)).toBeNull();
    expect(await persist.getItem(NAME)).toBeNull();
  });

  it('leaves an unparseable raw entry alone instead of adopting or deleting it', async () => {
    const { kv, legacy, storage } = harness();
    legacy.setItem(NAME, '{not json');

    expect(await storage().getItem(NAME)).toBeNull();
    expect(legacy.getItem(NAME)).toBe('{not json');
    expect(await kv.get(NAME, 'account')).toBeNull();
  });

  it('ignores a raw entry that is not a persist envelope', async () => {
    const { kv, legacy, storage } = harness();
    legacy.setItem(NAME, JSON.stringify({ nickname: 'Ada' }));

    expect(await storage().getItem(NAME)).toBeNull();
    expect(await kv.get(NAME, 'account')).toBeNull();
  });

  it('adopts an envelope with no version field', async () => {
    const { storage, legacy } = harness();
    legacy.setItem(NAME, JSON.stringify({ state: { nickname: 'Ada' } }));

    expect(await storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' } });
  });

  it('skips adoption entirely when the store opts out', async () => {
    const { kv, legacy } = harness();
    seedLegacy(legacy, { nickname: 'Ada' });
    const persist = createKVPersistStorage<Prefs>('account', { kv, legacyStorage: null });

    expect(await persist.getItem(NAME)).toBeNull();
    expect(legacy.getItem(NAME)).toBe(JSON.stringify({ state: { nickname: 'Ada' }, version: 4 }));
  });
});

describe('createKVPersistStorage — no browser storage (SSR)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('degrades to a no-op instead of throwing', async () => {
    // No `kv` injected and no ambient localStorage: the store module is
    // evaluated on the server too, where persist must simply do nothing.
    const persist = createKVPersistStorage<Prefs>('account');

    expect(await persist.getItem(NAME)).toBeNull();
    await expect(persist.setItem(NAME, { state: { nickname: 'Ada' } })).resolves.toBeUndefined();
    await expect(persist.removeItem(NAME)).resolves.toBeUndefined();
  });
});
