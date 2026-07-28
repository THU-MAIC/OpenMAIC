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
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { BrowserKVStore, type KVScope, type KVStore } from '@openmaic/storage';

import { createKVPersistStorage } from '@/lib/store/kv-persist';
import {
  resetPersistHealth,
  subscribeToPersistHealth,
  type PersistHealthEvent,
} from '@/lib/store/persist-health';

/**
 * Let the seam's detached recovery chain and the health channel's deferred
 * publish both run to completion. Two turns: recovery is scheduled on one, the
 * notice it does or does not cancel on the next.
 */
const flushTasks = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

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
  failRemove = false;
  /** Fail only the reads whose key matches — for per-operation fault cases. */
  failGetMatching: ((key: string) => boolean) | null = null;
  #removeGate: { match: (key: string) => boolean; wait: Promise<void> } | null = null;

  /** Hold the next matching `remove` until the returned function is called. */
  stallRemove(match: (key: string) => boolean): () => void {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#removeGate = { match, wait };
    return release;
  }
  /** Likewise for writes, so a sentinel can fail while the blob succeeds. */
  failSetMatching: ((key: string) => boolean) | null = null;
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
    if (this.failGet || this.failGetMatching?.(key)) throw new Error('kv get failed');
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
    if (this.failSet || this.failSetMatching?.(key)) throw new Error('kv set failed');
    if (this.gate?.match(key)) {
      const { wait } = this.gate;
      this.gate = null;
      await wait;
    }
    return this.inner.set(key, value, scope);
  }
  async remove(key: string, scope?: KVScope): Promise<void> {
    if (this.failRemove) throw new Error('kv remove failed');
    if (this.#removeGate?.match(key)) {
      const { wait } = this.#removeGate;
      this.#removeGate = null;
      await wait;
    }
    return this.inner.remove(key, scope);
  }
  async keys(prefix?: string, scope?: KVScope): Promise<string[]> {
    return this.inner.keys(prefix, scope);
  }
}

const NAME = 'settings-storage';
/**
 * Both sentinels are `device`-scoped whatever scope the store uses, and carry a
 * reserved `__` prefix. They record what happened to *this machine's* files, so
 * a syncing `account` backend must not carry them to a machine whose files they
 * describe nothing about.
 */
const MARKER = `__persist-adopted:${NAME}`;
const PRE_PERSIST_SENTINEL = `__pre-persist-consulted:${NAME}`;
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

/**
 * Two devices sharing one `account` scope and nothing else: separate
 * `localStorage` files, and separate `device` scopes. This is what a
 * server-backed `account` backend looks like, and the arrangement in which
 * device-local bookkeeping stored beside the data does damage.
 */
function twoDevices() {
  const accountBacking = new MemoryStorage();
  const makeDevice = () => {
    const deviceBacking = new MemoryStorage();
    const legacy = new MemoryStorage();
    // `account` reads/writes hit the shared file; `device` stays private.
    const kv: KVStore = {
      get: (key, scope) =>
        new BrowserKVStore({
          storage: scope === 'device' ? deviceBacking : accountBacking,
        }).get(key, scope),
      set: (key, value, scope) =>
        new BrowserKVStore({
          storage: scope === 'device' ? deviceBacking : accountBacking,
        }).set(key, value, scope),
      remove: (key, scope) =>
        new BrowserKVStore({
          storage: scope === 'device' ? deviceBacking : accountBacking,
        }).remove(key, scope),
      keys: (prefix, scope) =>
        new BrowserKVStore({
          storage: scope === 'device' ? deviceBacking : accountBacking,
        }).keys(prefix, scope),
    };
    return {
      legacy,
      kv,
      storage: () => createKVPersistStorage<Prefs>('account', { kv, legacyStorage: legacy }),
    };
  };
  return { accountBacking, deviceA: makeDevice(), deviceB: makeDevice() };
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

/** Health events raised during a test, in order. */
let health: PersistHealthEvent[] = [];
/** Just the ones the user would actually see as a standing problem. */
const problems = () => health.filter((e) => e.status !== 'recovered').map((e) => e.name);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetPersistHealth();
  health = [];
  subscribeToPersistHealth((event) => health.push(event));
});
afterEach(() => {
  vi.restoreAllMocks();
  resetPersistHealth();
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

  it('keeps its sentinels in the device scope even for an account store', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    await h.storage('account').getItem(NAME);

    // The marker records that *this machine's* raw file was moved. Stored in
    // `account` it would sync, and authorize deleting another machine's file.
    expect(await h.kv.get(MARKER, 'device')).toBe(true);
    expect(await h.kv.get(MARKER, 'account')).toBeNull();
  });

  it('keeps the pre-persist sentinel in the device scope too', async () => {
    const h = harness();
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      prePersistFallback: () => ({ state: { nickname: 'ancient' }, version: 4 }),
    });
    await persist.getItem(NAME);

    expect(await h.kv.get(PRE_PERSIST_SENTINEL, 'device')).toBe(true);
    expect(await h.kv.get(PRE_PERSIST_SENTINEL, 'account')).toBeNull();
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
    // a KV entry of unknown provenance. It is device-scoped: it describes this
    // machine's files, not the account's data.
    expect(await h.kv.get(MARKER, 'device')).toBe(true);
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

  it('a failed write closes the key rather than reporting a save that did not happen', async () => {
    // The write's outcome goes to the machine like any other. Ignoring it left
    // the key `settled` on the strength of a write that never landed, so the
    // app went on believing it was saving.
    const h = harness();
    const persist = await hydrated(h.storage());

    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'doomed' } });
    await flushTasks();

    expect(problems()).toEqual([NAME]);
    h.kv.failSet = false;
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });

  it('reopens the key once a read confirms the backend is back', async () => {
    const h = harness();
    const persist = await hydrated(h.storage());
    await persist.setItem(NAME, { state: { nickname: 'stored' }, version: 4 });

    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    h.kv.failSet = false;
    await persist.getItem(NAME);

    // The refused edit was taken against real hydrated data, so it is the
    // newest copy there is and gets replayed rather than dropped.
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'edited' }, version: 4 });
  });

  it('does not leave the queue wedged after a failed write', async () => {
    const h = harness();
    const persist = await hydrated(h.storage());

    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'doomed' } });
    h.kv.failSet = false;
    // A read still runs — the chain is intact even though the key is closed.
    await expect(persist.getItem(NAME)).resolves.toBeNull();
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

  it('does not claim a licence to delete raw entries it never adopted', async () => {
    // The adoption marker means "a raw persist entry on this device was moved
    // into KV". The fallback moves nothing of the sort, so it must not write
    // one — otherwise a raw entry later restored by an older bundle or a
    // rollback, holding real data nothing has read, is deleted on sight.
    const h = harness();
    await withFallback(h, () => fallbackValue).getItem(NAME);

    expect(await h.kv.get(MARKER, 'device')).toBeNull();

    seedLegacy(h.legacy, { nickname: 'restored by an older build' });
    await withFallback(h, () => fallbackValue).getItem(NAME);

    expect(h.legacy.getItem(NAME)).not.toBeNull();
  });

  it('is not consulted when the KV read failed', async () => {
    const h = harness();
    const fallback = vi.fn(() => fallbackValue);
    h.kv.failGet = true;

    expect(await withFallback(h, fallback).getItem(NAME)).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('createKVPersistStorage — two devices on one account scope', () => {
  it("does not let one device's migration authorize deleting another's raw file", async () => {
    // Device A upgrades first and migrates its raw entry into the shared
    // `account` scope. Device B has never run the new build, so its raw file is
    // still the only copy of *its* settings and has never been read.
    const { deviceA, deviceB } = twoDevices();
    seedLegacy(deviceA.legacy, { nickname: 'from A' });
    seedLegacy(deviceB.legacy, { nickname: 'only copy on B' });

    await deviceA.storage().getItem(NAME);
    expect(deviceA.legacy.getItem(NAME)).toBeNull();

    // B now loads. The account entry (A's) shadows its raw file — but A's
    // migration marker is device-local, so B has no licence to delete.
    expect(await deviceB.storage().getItem(NAME)).toEqual({
      state: { nickname: 'from A' },
      version: 4,
    });
    expect(deviceB.legacy.getItem(NAME)).not.toBeNull();
  });

  it('still drops a stale raw file on the device that migrated it', async () => {
    // The device-local marker must not be so conservative that it stops the
    // case it exists for.
    const { deviceA } = twoDevices();
    seedLegacy(deviceA.legacy, { nickname: 'from A' });
    const persist = deviceA.storage();
    await persist.getItem(NAME);

    seedLegacy(deviceA.legacy, { nickname: 'stale' });
    await persist.getItem(NAME);

    expect(deviceA.legacy.getItem(NAME)).toBeNull();
  });

  it('does not republish one device’s pre-persist keys after the account entry is cleared', async () => {
    // The chain this closes: A migrates and later clears the account entry
    // (cache button, or a server-side wipe). B still has its pre-persist keys
    // on disk — including credentials the user rotated years ago. Without a
    // per-device sentinel B would read them and republish them to the account
    // scope, syncing them back to every device.
    const { deviceA, deviceB } = twoDevices();
    const ancient = () => ({ state: { nickname: 'rotated-credential' }, version: 4 });

    const bPersist = createKVPersistStorage<Prefs>('account', {
      kv: deviceB.kv,
      legacyStorage: deviceB.legacy,
      prePersistFallback: ancient,
    });
    await bPersist.getItem(NAME);
    expect(await deviceB.kv.get(NAME, 'account')).toEqual(ancient());

    // The account entry is wiped from the other device.
    await deviceA.storage().removeItem(NAME);
    expect(await deviceB.kv.get(NAME, 'account')).toBeNull();

    // B reloads. Its pre-persist keys are untouched on disk, and must stay put.
    const fallback = vi.fn(ancient);
    const bAfterWipe = createKVPersistStorage<Prefs>('account', {
      kv: deviceB.kv,
      legacyStorage: deviceB.legacy,
      prePersistFallback: fallback,
    });

    expect(await bAfterWipe.getItem(NAME)).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
    expect(await deviceB.kv.get(NAME, 'account')).toBeNull();
  });
});

describe('createKVPersistStorage — writes issued during hydration', () => {
  it('refuses a write issued while the read is still in flight', async () => {
    // The gate has to be read when `setItem` is *called*. Checked inside the
    // queued task instead, this write waits behind `getItem`, finds the gate
    // opened by the very read it raced, and lands its pre-hydration snapshot
    // on top of the stored value.
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'stored' });

    const persist = h.storage();
    const releaseRead = h.kv.stallGetAfterRead(isBlobKey);
    const load = persist.getItem(NAME);

    // zustand issues this from a `set()` that ran before hydration resolved.
    const prematureWrite = persist.setItem(NAME, { state: { nickname: '' }, version: 4 });

    releaseRead();
    await Promise.all([load, prematureWrite]);

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'stored' }, version: 4 });
  });

  it('allows the write zustand issues once hydration has resolved', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'stored' });
    const persist = h.storage();

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'edited' }, version: 4 });
  });
});

describe('createKVPersistStorage — refused writes ask for recovery, then say so', () => {
  it('asks the store to rehydrate on the first refusal only', async () => {
    const h = harness();
    h.kv.failGet = true;
    const onWriteRefused = vi.fn();
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      onWriteRefused,
    });

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await persist.setItem(NAME, { state: { nickname: 'b' } });

    expect(onWriteRefused).toHaveBeenCalledTimes(1);
  });

  it('logs every refusal, not just the first', async () => {
    // A once-per-session warning hides how long changes have been going
    // unsaved, which is the only thing the log is for here.
    const h = harness();
    h.kv.failGet = true;
    const persist = h.storage();
    await persist.getItem(NAME);

    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await persist.setItem(NAME, { state: { nickname: 'b' } });
    await persist.setItem(NAME, { state: { nickname: 'c' } });

    const refusals = (console.error as unknown as Mock).mock.calls.filter((call) =>
      String(call[0] ?? '').includes('Refusing to persist'),
    );
    expect(refusals).toHaveLength(3);
  });

  it('unblocks persistence when the recovery attempt works', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'stored' });
    h.kv.failGet = true;

    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      // A real store rehydrates; here that is the backend recovering and the
      // adapter re-reading.
      onWriteRefused: async () => {
        h.kv.failGet = false;
        await persist.getItem(NAME);
      },
    });

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await flushTasks();

    await persist.setItem(NAME, { state: { nickname: 'b' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'b' }, version: 4 });
  });

  it('says so when the edits it could not replay are dropped', async () => {
    // The refused write was taken while the store held the *raw* copy, served
    // read-only after a failed read. That copy is by construction older than
    // whatever the account scope holds, so the edit cannot be written back —
    // and the user has to hear that it is gone rather than watch it vanish.
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'stored' });
    h.kv.failGet = true;

    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      onWriteRefused: async () => {
        h.kv.failGet = false;
        await persist.getItem(NAME);
      },
    });

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'edited' } });
    await flushTasks();

    expect(health.map((event) => event.status)).toContain('changes-lost');
  });

  it('stays quiet through a recovery with nothing owed', async () => {
    // Storage broke and came back before anything was written. The warning is
    // published on a later task precisely so a recovery this quick can cancel
    // it before anyone sees it.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' } }, 'account');
    const persist = h.storage();

    h.kv.failGet = true;
    await persist.getItem(NAME);
    h.kv.failGet = false;
    await persist.getItem(NAME);
    await flushTasks();

    expect(problems()).toEqual([]);
  });

  it('raises a durable notice when recovery does not work', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'stored' });
    h.kv.failGet = true;

    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      onWriteRefused: async () => {
        // The backend is still down, so the retry changes nothing.
        await persist.getItem(NAME);
      },
    });

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await flushTasks();

    expect(problems()).toEqual([NAME]);
  });

  it('raises the notice when the recovery attempt itself throws', async () => {
    const h = harness();
    h.kv.failGet = true;

    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      onWriteRefused: () => Promise.reject(new Error('rehydrate failed')),
    });

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await flushTasks();

    expect(problems()).toEqual([NAME]);
  });
});

describe('createKVPersistStorage — removeItem reports failure', () => {
  it('propagates a backend failure instead of reporting a clear that did not happen', async () => {
    const h = harness();
    const persist = await hydrated(h.storage());
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });

    h.kv.failRemove = true;
    await expect(persist.removeItem(NAME)).rejects.toThrow(/Could not remove/);

    // Nothing was destroyed on the way to that failure either.
    h.kv.failRemove = false;
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('leaves the raw entry alone when the KV copy could not be removed', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();
    await persist.getItem(NAME);
    seedLegacy(h.legacy, { nickname: 'reappeared' });

    h.kv.failRemove = true;
    await expect(persist.removeItem(NAME)).rejects.toThrow();

    expect(h.legacy.getItem(NAME)).not.toBeNull();
  });

  it('does not clear the pre-persist sentinel — it is monotonic', async () => {
    const h = harness();
    const fallback = vi.fn(() => ({ state: { nickname: 'ancient' }, version: 4 }));
    const make = () =>
      createKVPersistStorage<Prefs>('account', {
        kv: h.kv,
        legacyStorage: h.legacy,
        prePersistFallback: fallback,
      });

    await make().getItem(NAME);
    await make().removeItem(NAME);

    expect(await h.kv.get(PRE_PERSIST_SENTINEL, 'device')).toBe(true);
    // Clearing the entry is exactly the case the sentinel exists for.
    expect(await make().getItem(NAME)).toBeNull();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe('createKVPersistStorage — clearing closes the gate synchronously', () => {
  it('refuses a write issued while the clear is genuinely in flight', async () => {
    // The concurrency is real: an always-on initializer issues `set()` on every
    // load. Admitted here, that write queues behind the delete and puts the
    // credentials the user just cleared straight back.
    const h = harness();
    const persist = await hydrated(h.storage());
    await persist.setItem(NAME, { state: { nickname: 'secret' }, version: 4 });

    const releaseDelete = h.kv.stallRemove(isBlobKey);
    const clearing = persist.removeItem(NAME);
    // The delete is parked inside the backend, so this write is issued while
    // the clear really is outstanding.
    const racingWrite = persist.setItem(NAME, { state: { nickname: 'secret' }, version: 4 });
    releaseDelete();

    await Promise.all([clearing, racingWrite]);

    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });

  it('does not let a read finishing mid-clear reopen the gate', async () => {
    // A rehydrate already in flight when a clear starts is ordinary under a
    // remote backend — recovery triggers one. Its `settle` must not open the
    // key: a write admitted in that window queues behind the pending delete and
    // restores exactly what the user asked to remove.
    const h = harness();
    const persist = await hydrated(h.storage());
    await persist.setItem(NAME, { state: { nickname: 'secret' }, version: 4 });

    // A read is in flight...
    const releaseRead = h.kv.stallGetAfterRead(isBlobKey);
    const inFlightRead = persist.getItem(NAME);
    // ...when the clear begins, and the delete parks inside the backend.
    const releaseDelete = h.kv.stallRemove(isBlobKey);
    const clearing = persist.removeItem(NAME);

    // The read now runs to completion and settles, while the delete is still
    // outstanding. This is the window.
    releaseRead();
    await inFlightRead;
    await flushTasks();

    const racingWrite = persist.setItem(NAME, { state: { nickname: 'secret' }, version: 4 });
    releaseDelete();
    await Promise.all([clearing, racingWrite]);

    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });

  it('does not replay a refused write across a clear', async () => {
    // Replaying here would resurrect exactly what the user asked to delete.
    const h = harness();
    const persist = await hydrated(h.storage());
    await persist.setItem(NAME, { state: { nickname: 'secret' }, version: 4 });

    const clearing = persist.removeItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'secret' }, version: 4 });
    await clearing;

    expect(await persist.getItem(NAME)).toBeNull();
    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });

  it('accepts writes again once the clear has completed', async () => {
    const h = harness();
    const persist = await hydrated(h.storage());
    await persist.removeItem(NAME);

    await persist.setItem(NAME, { state: { nickname: 'after' }, version: 4 });

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'after' }, version: 4 });
  });
});

describe('createKVPersistStorage — the pre-persist sentinel is recorded by every settling path', () => {
  const fallbackValue = { state: { nickname: 'ancient' }, version: 4 };

  function withFallbackOn(h: ReturnType<typeof harness>, fallback: () => typeof fallbackValue) {
    return createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      prePersistFallback: fallback,
    });
  }

  it('records it after loading an already-populated KV entry', async () => {
    // The path that used to record nothing. A device that only ever loaded a
    // synced `account` entry stayed eligible to republish its own stale keys
    // the moment that entry was cleared.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'from the account' } }, 'account');
    const fallback = vi.fn(() => fallbackValue);

    await withFallbackOn(h, fallback).getItem(NAME);
    expect(await h.kv.get(PRE_PERSIST_SENTINEL, 'device')).toBe(true);

    // The account entry is wiped elsewhere; the stale keys must stay put.
    await h.kv.remove(NAME, 'account');
    expect(await withFallbackOn(h, fallback).getItem(NAME)).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('records it after adopting a raw entry', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });

    await withFallbackOn(h, () => fallbackValue).getItem(NAME);

    expect(await h.kv.get(PRE_PERSIST_SENTINEL, 'device')).toBe(true);
  });

  it('records it after concluding that there is nothing anywhere', async () => {
    const h = harness();
    const fallback = vi.fn((): typeof fallbackValue | null => null);

    await withFallbackOn(h, fallback as () => typeof fallbackValue).getItem(NAME);

    expect(await h.kv.get(PRE_PERSIST_SENTINEL, 'device')).toBe(true);
  });

  it('does not settle when the sentinel cannot be recorded', async () => {
    // A settled key promises the pre-persist keys have been dealt with. If that
    // record did not land, the promise is not one this device can keep.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' } }, 'account');
    const persist = withFallbackOn(h, () => fallbackValue);

    h.kv.failSet = true;
    await persist.getItem(NAME);
    h.kv.failSet = false;

    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'stored' } });
  });

  it('does not settle when the sentinel read fails', async () => {
    // "The backend could not answer" must not be read as "already recorded" —
    // that settles the key on a promise this device has no record of keeping.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' } }, 'account');
    const persist = withFallbackOn(h, () => fallbackValue);

    h.kv.failGetMatching = (key) => key.startsWith('__pre-persist-consulted:');
    await persist.getItem(NAME);
    h.kv.failGetMatching = null;

    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'stored' } });
    await flushTasks();
    expect(problems()).toEqual([NAME]);
  });

  it('aborts rather than adopting when the sentinel read fails', async () => {
    // "Could not answer" read as "never consulted" would republish the keys.
    const h = harness();
    const fallback = vi.fn(() => fallbackValue);
    const persist = withFallbackOn(h, fallback);

    h.kv.failGetMatching = (key) => key.startsWith('__pre-persist-consulted:');
    expect(await persist.getItem(NAME)).toBeNull();

    expect(fallback).not.toHaveBeenCalled();
    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });
});

describe('createKVPersistStorage — adoption needs its marker to land', () => {
  it('keeps the raw entry when the adoption marker cannot be written', async () => {
    // The marker is the licence to delete. Without it durably recorded there is
    // no proof for the next load, so deleting now would strand the raw copy's
    // only reader.
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();

    h.kv.failSetMatching = (key) => key.startsWith('__persist-adopted:');
    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });

    expect(h.legacy.getItem(NAME)).not.toBeNull();
    expect(await h.kv.get(MARKER, 'device')).toBeNull();
  });

  it('does not settle when the adoption marker cannot be written', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();

    h.kv.failSetMatching = (key) => key.startsWith('__persist-adopted:');
    await persist.getItem(NAME);
    h.kv.failSetMatching = null;

    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('settles into a harmless duplicate rather than an unproven delete', async () => {
    // The blob landed and the marker did not, so later loads read the KV copy
    // and keep the raw one. That duplicate is the deliberate resting place: the
    // marker means "our write succeeded and this raw entry is its leftover",
    // and writing the marker first instead would let an aborted attempt
    // authorize deleting a raw entry some *other* writer's KV value shadows.
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });

    h.kv.failSetMatching = (key) => key.startsWith('__persist-adopted:');
    await h.storage().getItem(NAME);
    h.kv.failSetMatching = null;

    const persist = h.storage();
    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'Ada' }, version: 4 });
    expect(h.legacy.getItem(NAME)).not.toBeNull();
    // Whichever copy is read, the data is the same, and the key is usable.
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'edited' }, version: 4 });
  });
});

describe('createKVPersistStorage — adoption re-reads before committing', () => {
  it('does not roll back a value another tab wrote while the migration ran', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'old raw copy' });

    const persist = h.storage();
    // The other tab lands its write between this adapter's first read and its
    // adoption write.
    const releaseRead = h.kv.stallGetAfterRead(isBlobKey);
    const load = persist.getItem(NAME);
    await h.kv.set(NAME, { state: { nickname: 'newer from another tab' }, version: 4 }, 'account');
    releaseRead();

    expect(await load).toEqual({ state: { nickname: 'newer from another tab' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toEqual({
      state: { nickname: 'newer from another tab' },
      version: 4,
    });
  });

  it('abandons the adoption when the confirming re-read fails', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();

    let reads = 0;
    h.kv.failGetMatching = (key) => key === NAME && ++reads > 1;
    await persist.getItem(NAME);

    // Nothing written, nothing deleted, and the key stays closed to writes.
    expect(h.legacy.getItem(NAME)).not.toBeNull();
    h.kv.failGetMatching = null;
    expect(await h.kv.get(NAME, 'account')).toBeNull();
  });
});

describe('createKVPersistStorage — a failed read never authorizes anything', () => {
  it('keeps the shadowed raw entry when the marker read fails', async () => {
    // "Could not answer" is not "no marker", but it is equally not "marker
    // present": neither reading grants permission to delete.
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();
    await persist.getItem(NAME);
    seedLegacy(h.legacy, { nickname: 'reappeared' });

    h.kv.failGetMatching = (key) => key.startsWith('__persist-adopted:');
    await persist.getItem(NAME);

    expect(h.legacy.getItem(NAME)).not.toBeNull();
  });

  it('does not settle when the confirming re-read fails', async () => {
    // Nothing in KV, nothing raw, and the confirmation could not be made. That
    // is not "the store is empty" — it is "we do not know", and an unknown key
    // must not be writable.
    const h = harness();
    const persist = h.storage();

    let reads = 0;
    h.kv.failGetMatching = (key) => key === NAME && ++reads > 1;
    expect(await persist.getItem(NAME)).toBeNull();
    h.kv.failGetMatching = null;

    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toBeNull();
    await flushTasks();
    expect(problems()).toEqual([NAME]);
  });
});

describe('createKVPersistStorage — never deletes bytes it could not read', () => {
  it('keeps an unparseable raw entry even with a completed migration on record', async () => {
    const h = harness();
    seedLegacy(h.legacy, { nickname: 'Ada' });
    const persist = h.storage();
    await persist.getItem(NAME);

    // A marker exists now, but these bytes are not ones this seam wrote and
    // nothing here understands them.
    h.legacy.setItem(NAME, '{not json');
    await persist.getItem(NAME);

    expect(h.legacy.getItem(NAME)).toBe('{not json');
  });
});

describe('createKVPersistStorage — a provisionally served value is not authoritative', () => {
  it('never replays an edit built on the raw copy over the account value', async () => {
    // Device B keeps a raw entry shadowed by the account value — the designed
    // resting place when B never completed a migration of its own. One
    // transient read failure on B serves that older copy, and if an edit taken
    // against it were replayable, recovery would write it over the account and
    // roll every device back.
    const { deviceA, deviceB } = twoDevices();
    seedLegacy(deviceB.legacy, { nickname: 'old copy on B' });

    seedLegacy(deviceA.legacy, { nickname: 'current, from A' });
    await deviceA.storage().getItem(NAME);

    const failing = new ControllableKV(deviceB.kv);
    const bPersist = createKVPersistStorage<Prefs>('account', {
      kv: failing,
      legacyStorage: deviceB.legacy,
      onWriteRefused: async () => {
        failing.failGet = false;
        await bPersist.getItem(NAME);
      },
    });

    failing.failGet = true;
    // B hydrates from its own stale raw copy.
    expect(await bPersist.getItem(NAME)).toEqual({
      state: { nickname: 'old copy on B' },
      version: 4,
    });
    await bPersist.setItem(NAME, { state: { nickname: 'edited on B' }, version: 4 });
    await flushTasks();

    // The account value stands; nothing was rolled back.
    expect(await deviceA.kv.get(NAME, 'account')).toEqual({
      state: { nickname: 'current, from A' },
      version: 4,
    });
    // And B's user is told their edit did not survive.
    expect(health.map((event) => event.status)).toContain('changes-lost');
  });

  it('does replay an edit built on the value the account scope returned', async () => {
    // The contrasting case, so the rule is "authoritative or not" rather than
    // "never replay".
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    const persist = h.storage();
    await persist.getItem(NAME);

    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    h.kv.failSet = false;
    await persist.getItem(NAME);

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'edited' }, version: 4 });
  });
});

describe('createKVPersistStorage — a landed write supersedes an earlier failed one', () => {
  it('does not replay a stale snapshot over a newer write that succeeded', async () => {
    // Both writes are admitted while the key is open, so both are queued. The
    // first fails and is remembered; the second lands. Replaying the first on
    // recovery would undo the second.
    const h = harness();
    // Seeded and read first, so the store is holding the authoritative value
    // and a remembered failure would genuinely be replayable.
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    const persist = h.storage();
    await persist.getItem(NAME);

    let sets = 0;
    h.kv.failSetMatching = (key) => key === NAME && ++sets === 1;
    const first = persist.setItem(NAME, { state: { nickname: 'A' }, version: 4 });
    const second = persist.setItem(NAME, { state: { nickname: 'B' }, version: 4 });
    await Promise.all([first, second]);
    h.kv.failSetMatching = null;

    await persist.getItem(NAME);

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'B' }, version: 4 });
  });
});

describe('createKVPersistStorage — unreachable browser storage is a failure, not an empty store', () => {
  /** A browser whose `localStorage` getter throws, as privacy modes do. */
  function withHostileLocalStorage(): () => void {
    const restore = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('localStorage is denied');
      },
    });
    vi.stubGlobal('window', {});
    return () => {
      if (restore) Object.defineProperty(globalThis, 'localStorage', restore);
      else Reflect.deleteProperty(globalThis, 'localStorage');
      vi.unstubAllGlobals();
    };
  }

  it('signals instead of hydrating an empty store in silence', async () => {
    const restore = withHostileLocalStorage();
    try {
      const persist = createKVPersistStorage<Prefs>('account');

      expect(await persist.getItem(NAME)).toBeNull();
      await persist.setItem(NAME, { state: { nickname: 'lost' } });
      await flushTasks();

      expect(problems()).toEqual([NAME]);
    } finally {
      restore();
    }
  });

  it('reports a clear it could not perform', async () => {
    const restore = withHostileLocalStorage();
    try {
      const persist = createKVPersistStorage<Prefs>('account');
      await expect(persist.removeItem(NAME)).rejects.toThrow(/unreachable/);
    } finally {
      restore();
    }
  });
});

describe('createKVPersistStorage — recovery is asked for again after it worked', () => {
  it('re-arms the recovery latch once storage answers', async () => {
    const h = harness();
    const asked: string[] = [];
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      onWriteRefused: (name) => void asked.push(name),
    });

    h.kv.failGet = true;
    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await flushTasks();
    expect(asked).toHaveLength(1);

    // Storage comes back and the key settles...
    h.kv.failGet = false;
    await persist.getItem(NAME);
    await flushTasks();

    // ...so a later failure gets its own recovery attempt, rather than the
    // latch making every transition after the first an empty promise.
    h.kv.failGet = true;
    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'b' } });
    await flushTasks();

    expect(asked).toHaveLength(2);
  });

  it('asks only once while the failure persists', async () => {
    const h = harness();
    const asked: string[] = [];
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      legacyStorage: h.legacy,
      onWriteRefused: (name) => void asked.push(name),
    });

    h.kv.failGet = true;
    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await persist.setItem(NAME, { state: { nickname: 'b' } });
    await persist.getItem(NAME);
    await flushTasks();

    expect(asked).toHaveLength(1);
  });
});

describe('createKVPersistStorage — cold-start writes are not an alarm', () => {
  it('says nothing to the user when a healthy backend simply had not hydrated yet', async () => {
    // An always-on initializer writes on every load, routinely before the
    // first read resolves. Nothing is broken; a sticky red toast here would be
    // a bug report about a working app.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    const persist = h.storage();

    const releaseRead = h.kv.stallGetAfterRead(isBlobKey);
    const load = persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: '' }, version: 4 });
    releaseRead();
    await load;
    await flushTasks();

    expect(health).toEqual([]);
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'stored' }, version: 4 });
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
