/**
 * The zustand `persist` ↔ `KVStore` seam (lib/store/kv-persist.ts).
 *
 * What is load-bearing here is invisible from the store code: the scope a store
 * writes under, the one-time adoption of the raw `localStorage` entry zustand's
 * default storage left behind, and — because the storage is asynchronous now —
 * that no failed read, interleaved tab, or out-of-order write can end with the
 * user's data replaced by defaults.
 *
 * Most cases below are therefore *sequences*, not single calls: one adapter
 * used in order is the single arrangement that was already safe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserKVStore, type KVScope, type KVStore } from '@openmaic/storage';

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

/**
 * A `KVStore` decorator that can be told to fail, or to hold a write until the
 * test releases it. Faults are the subject of these cases, so they are injected
 * at the backend rather than mocked at the adapter.
 */
class ControllableKV implements KVStore {
  failGet = false;
  failSet = false;
  private gate: { match: (key: string) => boolean; wait: Promise<void> } | null = null;

  constructor(private readonly inner: KVStore) {}

  /** Hold the next matching `set` until the returned function is called. */
  stallSet(match: (key: string) => boolean): () => void {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { match, wait };
    return release;
  }

  /**
   * Hold the next matching `get` *after* it has read, so the caller resolves
   * with the value as of the moment it asked. That is the only way to model a
   * reader whose view of the store is a snapshot older than the store itself —
   * the normal state of affairs against a remote backend.
   */
  stallGetAfterRead(match: (key: string) => boolean): () => void {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.readGate = { match, wait };
    return release;
  }
  private readGate: { match: (key: string) => boolean; wait: Promise<void> } | null = null;

  async get<T>(key: string, scope?: KVScope): Promise<T | null> {
    if (this.failGet) throw new Error('kv get failed');
    if (this.readGate?.match(key)) {
      const { wait } = this.readGate;
      this.readGate = null;
      const snapshot = await this.inner.get<T>(key, scope);
      await wait;
      return snapshot;
    }
    return this.inner.get<T>(key, scope);
  }
  async set<T>(key: string, value: T, scope?: KVScope): Promise<void> {
    if (this.failSet) throw new Error('kv set failed');
    if (this.gate?.match(key)) {
      const { wait } = this.gate;
      this.gate = null;
      await wait;
    }
    return this.inner.set(key, value, scope);
  }
  async remove(key: string, scope?: KVScope): Promise<void> {
    return this.inner.remove(key, scope);
  }
  async keys(prefix?: string, scope?: KVScope): Promise<string[]> {
    return this.inner.keys(prefix, scope);
  }
}

const NAME = 'settings-storage';
const MARKER = `persist-adopted:${NAME}`;
const isBlobKey = (key: string) => key === NAME;

interface Prefs {
  nickname: string;
}

function harness() {
  const backing = new MemoryStorage();
  const legacy = new MemoryStorage();
  const kv = new ControllableKV(new BrowserKVStore({ storage: backing }));
  return {
    backing,
    legacy,
    kv,
    /** A fresh adapter over the same backends — what a page reload builds. */
    storage: (scope: KVScope = 'account') =>
      createKVPersistStorage<Prefs>(scope, { kv, legacyStorage: legacy }),
  };
}

type PersistStorageUnderTest = ReturnType<ReturnType<typeof harness>['storage']>;

function seedLegacy(legacy: Storage, state: unknown, version = 4) {
  legacy.setItem(NAME, JSON.stringify({ state, version }));
}

/** `setItem` is refused until a read has settled the key, so hydrate first. */
async function hydrated(storage: PersistStorageUnderTest): Promise<PersistStorageUnderTest> {
  await storage.getItem(NAME);
  return storage;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKVPersistStorage — round trip', () => {
  it('reads back what it wrote, envelope intact', async () => {
    const persist = await hydrated(harness().storage());
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });
    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('returns null for a store that was never written', async () => {
    expect(await harness().storage().getItem(NAME)).toBeNull();
  });

  it('removeItem clears the entry', async () => {
    const persist = await hydrated(harness().storage());
    await persist.setItem(NAME, { state: { nickname: 'Ada' } });
    await persist.removeItem(NAME);
    expect(await persist.getItem(NAME)).toBeNull();
  });
});

describe('createKVPersistStorage — scope', () => {
  it('writes under the scope it was given, and only that scope', async () => {
    const h = harness();
    const persist = await hydrated(h.storage('device'));
    await persist.setItem(NAME, { state: { nickname: 'Ada' } });

    expect(await h.kv.get(NAME, 'device')).toEqual({ state: { nickname: 'Ada' } });
    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });

  it('does not read across scopes', async () => {
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'Ada' } }, 'account');

    // `device` data is defined as never leaving the machine, so the two scopes
    // stay disjoint even on a shared backend.
    expect(await h.storage('device').getItem(NAME)).toBeNull();
  });

  it('keeps its adoption marker in its own scope', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    await h.storage('device').getItem(NAME);

    expect(await h.kv.get(MARKER, 'device')).toBe(true);
    expect(await h.kv.get(MARKER, 'account')).toBeNull();
  });
});

describe('createKVPersistStorage — legacy localStorage adoption', () => {
  it('adopts the raw entry on first read and returns it', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });

    expect(await h.storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('moves the entry into the KV scope rather than copying it', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });

    await h.storage().getItem(NAME);

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    expect(h.legacy.getItem(NAME)).toBeNull();
    // The completion marker is how a later read tells a settled migration from
    // a KV entry of unknown provenance.
    expect(await h.kv.get(MARKER, 'account')).toBe(true);
  });

  it('adopts into whichever scope the store declared', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });

    await h.storage('device').getItem(NAME);

    expect(await h.kv.get(NAME, 'device')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });

  it('is idempotent — repeated reads neither duplicate nor re-migrate', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();

    const first = await persist.getItem(NAME);
    const second = await persist.getItem(NAME);
    const third = await persist.getItem(NAME);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(h.legacy.getItem(NAME)).toBeNull();
    expect(await h.kv.get(NAME, 'account')).toEqual(first);
  });

  it('survives a fresh storage instance, the way a page reload sees it', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });

    await h.storage().getItem(NAME);
    expect(await h.storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('drops a stale raw entry that reappears after a completed migration', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();
    await persist.getItem(NAME);

    // An older tab (or a re-run e2e seed) writes the pre-cutover key again.
    // The migration is on record, so this copy is known to be stale.
    seedLegacy(h.legacy, { nickname: 'stale' });

    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    expect(h.legacy.getItem(NAME)).toBeNull();
  });

  it('keeps a raw entry that appears with no migration on record', async () => {
    const h = harness();
    // A fresh install: KV is populated by ordinary use, never by adoption.
    const persist = await hydrated(h.storage());
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });
    seedLegacy(h.legacy, { nickname: 'unknown provenance' });

    // KV still wins the read...
    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    // ...but with no completed migration recorded, that raw entry might be the
    // only copy of something real. A shadowed duplicate is cheap; deleting an
    // original is not.
    expect(h.legacy.getItem(NAME)).not.toBeNull();
  });

  it('removeItem clears both homes and the marker, so nothing can be re-adopted', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();
    await persist.getItem(NAME);
    seedLegacy(h.legacy, { nickname: 'stale' });

    await persist.removeItem(NAME);

    expect(h.legacy.getItem(NAME)).toBeNull();
    expect(await h.kv.get(MARKER, 'account')).toBeNull();
    expect(await persist.getItem(NAME)).toBeNull();
  });

  it('leaves an unparseable raw entry alone instead of adopting or deleting it', async () => {
    const h = harness();
    h.legacy.setItem(NAME, '{not json');

    expect(await h.storage().getItem(NAME)).toBeNull();
    expect(h.legacy.getItem(NAME)).toBe('{not json');
    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });

  it('ignores a raw entry that is not a persist envelope', async () => {
    const h = harness();
    h.legacy.setItem(NAME, JSON.stringify({ nickname: 'Ada' }));

    expect(await h.storage().getItem(NAME)).toBeNull();
    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });

  it('adopts an envelope with no version field', async () => {
    const h = harness();
    h.legacy.setItem(NAME, JSON.stringify({ state: { nickname: 'Ada' } }));

    expect(await h.storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' } });
  });

  it('skips adoption entirely when the store opts out', async () => {
    const { kv, legacy } = harness();
    seedLegacy(legacy, { nickname: 'Ada' });
    const persist = createKVPersistStorage<Prefs>('account', { kv, legacyStorage: null });

    expect(await persist.getItem(NAME)).toBeNull();
    expect(legacy.getItem(NAME)).toBe(JSON.stringify({ state: { nickname: 'Ada' }, version: 4 }));
  });
});

describe('createKVPersistStorage — a second reader mid-migration', () => {
  it('re-checks KV when its own two reads straddle another tab’s adoption', async () => {
    // Tab A adopts in three steps: write the KV entry, write the marker, drop
    // the raw entry. Tab B is interleaved so its KV read answers from *before*
    // A's write while its localStorage read happens *after* A's delete — both
    // empty, though the data never stopped existing. Without the re-check B
    // hydrates defaults, and its first write rolls A's entry back.
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });

    const tabA = h.storage();
    const tabB = h.storage();

    // B asks first and is held with an empty answer in hand.
    const releaseB = h.kv.stallGetAfterRead(isBlobKey);
    const bLoad = tabB.getItem(NAME);

    // A runs to completion in that window.
    await tabA.getItem(NAME);
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    expect(h.legacy.getItem(NAME)).toBeNull();

    // B resumes holding the stale "KV is empty", and localStorage is empty by
    // now too. Everything hinges on the re-check.
    releaseB();
    expect(await bLoad).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('a re-check that also comes up empty still settles the key', async () => {
    // The re-check must not turn a genuinely empty store into an unsettled one:
    // a fresh install has to stay writable.
    const h = harness();
    const persist = h.storage();

    expect(await persist.getItem(NAME)).toBeNull();
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('an adapter created after the migration loads the adopted value, not defaults', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    await h.storage().getItem(NAME);

    expect(await h.storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });
});

describe('createKVPersistStorage — backend failures must not lose data', () => {
  it('serves the raw entry read-only when the KV read fails', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    h.kv.failGet = true;

    // The store still hydrates with the user's data...
    expect(await h.storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    // ...and the original is neither adopted nor deleted.
    expect(h.legacy.getItem(NAME)).not.toBeNull();
  });

  it('refuses to persist after a failed read, so defaults cannot displace the original', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    h.kv.failGet = true;

    const persist = h.storage();
    await persist.getItem(NAME);

    // The write an always-on initializer issues on every load. Left unchecked
    // it lands defaults in KV, and the next load reads that as a completed
    // migration and deletes the raw original.
    await persist.setItem(NAME, { state: { nickname: '' }, version: 4 });

    h.kv.failGet = false;
    expect(await h.kv.get(NAME, 'account')).toBeNull();
    expect(h.legacy.getItem(NAME)).not.toBeNull();

    // A later load with a working backend re-adopts the original.
    expect(await h.storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('keeps the raw entry, and stays unwritable, when the adoption write fails', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    h.kv.failSet = true;

    const persist = h.storage();
    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    expect(h.legacy.getItem(NAME)).not.toBeNull();
    expect(await h.kv.get(MARKER, 'account')).toBeNull();

    h.kv.failSet = false;
    await persist.setItem(NAME, { state: { nickname: '' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toBeNull();

    expect(await h.storage().getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('surfaces a failed write instead of swallowing it', async () => {
    const h = harness();
    const persist = await hydrated(h.storage());
    h.kv.failSet = true;

    await persist.setItem(NAME, { state: { nickname: 'Ada' } });

    expect(console.error).toHaveBeenCalled();
  });

  it('refuses to persist before any read has settled the key', async () => {
    const h = harness();
    await h.storage().setItem(NAME, { state: { nickname: 'premature' } });

    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });
});

describe('createKVPersistStorage — write ordering', () => {
  it('applies writes in call order even when an earlier one resolves late', async () => {
    const h = harness();
    const persist = await hydrated(h.storage());

    const release = h.kv.stallSet(isBlobKey);
    const first = persist.setItem(NAME, { state: { nickname: 'first' }, version: 4 });
    const second = persist.setItem(NAME, { state: { nickname: 'second' }, version: 4 });

    release();
    await Promise.all([first, second]);

    // Unserialized, the stalled first write lands last and silently rolls the
    // newer value back.
    expect(await h.kv.get(NAME, 'account')).toEqual({
      state: { nickname: 'second' },
      version: 4,
    });
  });

  it('a failed write does not wedge the key for later writes', async () => {
    const h = harness();
    const persist = await hydrated(h.storage());

    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'doomed' } });
    h.kv.failSet = false;
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });
});

describe('createKVPersistStorage — pre-persist fallback', () => {
  const fallbackValue = { state: { nickname: 'ancient' }, version: 4 };

  function withFallback(
    h: ReturnType<typeof harness>,
    fallback: () => typeof fallbackValue | null,
  ) {
    return createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      prePersistFallback: fallback,
    });
  }

  it('is consulted only when both KV and the raw key are empty', async () => {
    const h = harness();
    const fallback = vi.fn(() => fallbackValue);

    expect(await withFallback(h, fallback).getItem(NAME)).toEqual(fallbackValue);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('is skipped once its result is adopted — it cannot re-run on every load', async () => {
    const h = harness();
    const fallback = vi.fn(() => fallbackValue);

    await withFallback(h, fallback).getItem(NAME);
    // Reloads. The adopted KV entry is the one-time marker; the sentinel this
    // replaced (does the raw key exist?) could not have stopped these, because
    // the raw key is exactly what the migration removes.
    await withFallback(h, fallback).getItem(NAME);
    await withFallback(h, fallback).getItem(NAME);

    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('never runs while a raw persist entry is still there to adopt', async () => {
    const h = harness();
    const fallback = vi.fn(() => fallbackValue);
    seedLegacy(h.legacy, { nickname: 'Ada' });

    expect(await withFallback(h, fallback).getItem(NAME)).toEqual({
      state: { nickname: 'Ada' },
      version: 4,
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('leaves the source keys alone — they are not the seam’s to delete', async () => {
    const h = harness();
    h.legacy.setItem('llmModel', 'openai:gpt-4o');

    await withFallback(h, () => fallbackValue).getItem(NAME);

    expect(h.legacy.getItem('llmModel')).toBe('openai:gpt-4o');
  });

  it('is not consulted when the KV read failed', async () => {
    const h = harness();
    const fallback = vi.fn(() => fallbackValue);
    h.kv.failGet = true;

    expect(await withFallback(h, fallback).getItem(NAME)).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
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
