/**
 * The zustand `persist` ↔ `KVStore` seam (lib/store/kv-persist.ts).
 *
 * The seam routes a store's persistence through the KV contract and **nothing
 * more**: it reads and writes the KV scope and never touches a legacy
 * `localStorage` key. There is no migration of pre-cutover data — an empty KV
 * scope hydrates the store to defaults.
 *
 * What remains load-bearing is async-storage *steady state*: because a KV
 * backend can be remote and can fail, no failed read, out-of-order write, or
 * clear-vs-write race may end with the user's data replaced by defaults, and a
 * write the backend refused must either be replayed on recovery or reported as
 * lost. Most cases below are therefore *sequences*, not single calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { BrowserKVStore, type KVScope, type KVStore } from '@openmaic/storage';

import { createKVPersistStorage, DEFAULT_RECOVERY_BACKOFF_MS } from '@/lib/store/kv-persist';
import {
  resetPersistHealth,
  subscribeToPersistHealth,
  type PersistHealthEvent,
} from '@/lib/store/persist-health';

/**
 * Let the seam's detached recovery chain and the health channel's deferred
 * publish both run to completion. Several turns: recovery is scheduled on one,
 * the notice it does or does not cancel on the next.
 */
const flushTasks = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/**
 * A `KVStore` decorator that can be told to fail, or to hold an operation until
 * the test releases it. Faults are the subject of these cases, so they are
 * injected at the backend rather than mocked at the adapter.
 */
class ControllableKV implements KVStore {
  failGet = false;
  failSet = false;
  failRemove = false;
  private setGate: { match: (key: string) => boolean; wait: Promise<void> } | null = null;
  private readGate: { match: (key: string) => boolean; wait: Promise<void> } | null = null;

  constructor(private readonly inner: KVStore) {}

  /** Hold the next matching `set` until the returned function is called. */
  stallSet(match: (key: string) => boolean): () => void {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.setGate = { match, wait };
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
    if (this.setGate?.match(key)) {
      const { wait } = this.setGate;
      this.setGate = null;
      await wait;
    }
    return this.inner.set(key, value, scope);
  }
  async remove(key: string, scope?: KVScope): Promise<void> {
    if (this.failRemove) throw new Error('kv remove failed');
    return this.inner.remove(key, scope);
  }
  async keys(prefix?: string, scope?: KVScope): Promise<string[]> {
    return this.inner.keys(prefix, scope);
  }
}

const NAME = 'settings-storage';
const isBlobKey = (key: string) => key === NAME;

interface Prefs {
  nickname: string;
}

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

function harness() {
  const backing = new MemoryStorage();
  const kv = new ControllableKV(new BrowserKVStore({ storage: backing }));
  return {
    backing,
    kv,
    /** A fresh adapter over the same KV backend — what a page reload builds. */
    storage: (scope: KVScope = 'account') => createKVPersistStorage<Prefs>(scope, { kv }),
  };
}

type PersistStorageUnderTest = ReturnType<ReturnType<typeof harness>['storage']>;

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

describe('createKVPersistStorage — empty KV hydrates defaults, no migration', () => {
  it('an empty KV scope reads null and the key becomes writable', async () => {
    // The whole "no migration" story at the adapter level: nothing is read but
    // the KV scope. Empty KV → null (zustand keeps its defaults) → settled, so
    // the user's first edit persists.
    const h = harness();
    const persist = h.storage();

    expect(await persist.getItem(NAME)).toBeNull();
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });

  it('the adapter takes no legacy storage — there is nothing it could migrate', () => {
    // A structural guarantee, not a runtime one: the deps have no legacy-source
    // field, so no code path can read a pre-cutover raw key.
    const persist = createKVPersistStorage<Prefs>('account', { kv: harness().kv });
    expect(typeof persist.getItem).toBe('function');
    expect(Object.keys({ kv: harness().kv })).toEqual(['kv']);
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
});

describe('createKVPersistStorage — a failed read never persists defaults', () => {
  it('returns null and refuses writes when the KV read fails', async () => {
    // A failed read is not an empty store. The key is left unsettled so the
    // always-on initializer's `set()` cannot land defaults over a value we
    // could not read.
    const h = harness();
    h.kv.failGet = true;
    const persist = h.storage();

    expect(await persist.getItem(NAME)).toBeNull();
    await persist.setItem(NAME, { state: { nickname: '' }, version: 4 });

    h.kv.failGet = false;
    expect(await h.kv.get(NAME, 'account')).toBeNull();
    await flushTasks();
    expect(problems()).toContain(NAME);
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

describe('createKVPersistStorage — writes issued during hydration', () => {
  it('refuses a write issued while the read is still in flight', async () => {
    // The gate has to be read when `setItem` is *called*. Checked inside the
    // queued task instead, this write waits behind `getItem`, finds the gate
    // opened by the very read it raced, and lands its pre-hydration snapshot
    // on top of the stored value.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');

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
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    const persist = h.storage();

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'edited' }, version: 4 });
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

  it('does not replay a stale snapshot over a newer write that succeeded', async () => {
    // Both writes are admitted while the key is open, so both are queued. The
    // first fails and is remembered; the second lands. Replaying the first on
    // recovery would undo the second.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    const persist = h.storage();
    await persist.getItem(NAME);

    const inner = h.kv;
    let sets = 0;
    const originalSet = inner.set.bind(inner);
    inner.set = async (key, value, scope) => {
      if (key === NAME && ++sets === 1) throw new Error('kv set failed');
      return originalSet(key, value, scope);
    };
    const first = persist.setItem(NAME, { state: { nickname: 'A' }, version: 4 });
    const second = persist.setItem(NAME, { state: { nickname: 'B' }, version: 4 });
    await Promise.all([first, second]);
    inner.set = originalSet;

    await persist.getItem(NAME);

    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'B' }, version: 4 });
  });
});

describe('createKVPersistStorage — clearing closes the gate synchronously', () => {
  it('refuses a write issued while the clear is in flight', async () => {
    // An always-on initializer issues `set()` on every load. Admitted here, that
    // write queues behind the delete and puts the credentials the user just
    // cleared straight back.
    const h = harness();
    const persist = await hydrated(h.storage());
    await persist.setItem(NAME, { state: { nickname: 'secret' }, version: 4 });

    const clearing = persist.removeItem(NAME);
    const racingWrite = persist.setItem(NAME, { state: { nickname: 'secret' }, version: 4 });
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

  it('propagates a backend failure instead of reporting a clear that did not happen', async () => {
    const h = harness();
    const persist = await hydrated(h.storage());
    await persist.setItem(NAME, { state: { nickname: 'Ada' }, version: 4 });

    h.kv.failRemove = true;
    await expect(persist.removeItem(NAME)).rejects.toThrow(/Could not remove/);

    h.kv.failRemove = false;
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'Ada' }, version: 4 });
  });
});

describe('createKVPersistStorage — refused writes ask for recovery, then say so', () => {
  it('asks the store to rehydrate on the first refusal only', async () => {
    const h = harness();
    h.kv.failGet = true;
    const onWriteRefused = vi.fn();
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      onWriteRefused,
      recoveryBackoffMs: [0],
    });

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await persist.setItem(NAME, { state: { nickname: 'b' } });
    await flushTasks();

    expect(onWriteRefused).toHaveBeenCalledTimes(1);
  });

  it('logs every refusal, not just the first', async () => {
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
    await h.kv.set(NAME, { state: { nickname: 'stored' } }, 'account');
    h.kv.failGet = true;

    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
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
    h.kv.failGet = true;

    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
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
      onWriteRefused: () => Promise.reject(new Error('rehydrate failed')),
    });

    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await flushTasks();

    expect(problems()).toEqual([NAME]);
  });
});

describe('createKVPersistStorage — a replay is owed until it lands', () => {
  it('does not drop the edit when the recovering read works but the replay write fails', async () => {
    // Readable but not writable is a real state — a quota-exhausted backend
    // answers reads perfectly. Retiring the snapshot on the strength of the
    // read alone loses the edit silently.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    const persist = h.storage();
    await persist.getItem(NAME);

    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });

    // Reads work again; writes still do not.
    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'edited' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'stored' }, version: 4 });

    // The edit is still owed, so the next recovery writes it rather than
    // handing back the stale stored value.
    h.kv.failSet = false;
    expect(await persist.getItem(NAME)).toEqual({ state: { nickname: 'edited' }, version: 4 });
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'edited' }, version: 4 });
  });

  it('eventually tells the user when the replay can never land', async () => {
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    const persist = h.storage();
    await persist.getItem(NAME);

    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    await persist.getItem(NAME);
    await persist.getItem(NAME);
    await flushTasks();

    expect(problems()).toContain(NAME);
  });

  it('clears the debt once the replay lands', async () => {
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    const persist = h.storage();
    await persist.getItem(NAME);

    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    h.kv.failSet = false;
    await persist.getItem(NAME);

    // A later write wins outright; the replay is not owed a second time.
    await persist.setItem(NAME, { state: { nickname: 'newer' }, version: 4 });
    await persist.getItem(NAME);
    expect(await h.kv.get(NAME, 'account')).toEqual({ state: { nickname: 'newer' }, version: 4 });
  });
});

describe('createKVPersistStorage — a lost edit is reported, not swallowed', () => {
  it('says so when an edit made while storage was down cannot be replayed', async () => {
    // The edit was taken while the store held only defaults (the read failed
    // before it ever loaded a value), so replaying it would overwrite the
    // stored value with defaults. It cannot be replayed — and the user is told.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');
    h.kv.failGet = true;

    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      onWriteRefused: async () => {
        h.kv.failGet = false;
        await persist.getItem(NAME);
      },
    });

    await persist.getItem(NAME); // fails → defaults, unsettled
    await persist.setItem(NAME, { state: { nickname: 'edited' } });
    await flushTasks();

    expect(health.map((event) => event.status)).toContain('changes-lost');
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

describe('createKVPersistStorage — recovery is bounded and re-armable', () => {
  it('stops retrying a backend that reads but cannot write', async () => {
    // The treadmill: the recovering read succeeds, the key settles, the replay
    // write fails, and that failure asks for recovery again. A quota-exhausted
    // backend behaves exactly like this, and unbounded it is a loop that never
    // lets the page settle.
    const h = harness();
    await h.kv.set(NAME, { state: { nickname: 'stored' }, version: 4 }, 'account');

    const attempts: string[] = [];
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      recoveryBackoffMs: [0, 0, 0],
      onWriteRefused: async (name) => {
        attempts.push(name);
        await persist.getItem(NAME);
      },
    });

    await persist.getItem(NAME);
    h.kv.failSet = true;
    await persist.setItem(NAME, { state: { nickname: 'edited' }, version: 4 });
    for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Exactly the budget: not "a few", and emphatically not one per lap.
    expect(attempts).toHaveLength(3);
    expect(health.map((event) => event.status)).toContain('changes-lost');
  });

  it('ships a schedule that actually backs off', () => {
    // A guard on the shipped default: an all-zero schedule would leave the cap
    // as the only thing between a flaky backend and a busy loop.
    expect(DEFAULT_RECOVERY_BACKOFF_MS.length).toBeGreaterThan(1);
    const delays = [...DEFAULT_RECOVERY_BACKOFF_MS];
    expect(delays.at(-1)).toBeGreaterThan(0);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it('re-arms the budget once storage answers', async () => {
    const h = harness();
    const asked: string[] = [];
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      onWriteRefused: (name) => void asked.push(name),
      recoveryBackoffMs: [0, 0],
    });

    h.kv.failGet = true;
    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await flushTasks();
    const spentOnFirstFault = asked.length;
    expect(spentOnFirstFault).toBe(2);

    // Storage comes back and the key settles clean...
    h.kv.failGet = false;
    await persist.getItem(NAME);
    await flushTasks();
    expect(asked).toHaveLength(spentOnFirstFault);

    // ...so a later failure gets a fresh budget.
    h.kv.failGet = true;
    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'b' } });
    await flushTasks();

    expect(asked.length).toBe(spentOnFirstFault + 2);
  });

  it('spends the budget once, however many writes are refused', async () => {
    const h = harness();
    const asked: string[] = [];
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      onWriteRefused: (name) => void asked.push(name),
      recoveryBackoffMs: [0, 0, 0],
    });

    h.kv.failGet = true;
    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await persist.setItem(NAME, { state: { nickname: 'b' } });
    await persist.setItem(NAME, { state: { nickname: 'c' } });
    await persist.getItem(NAME);
    await flushTasks();

    expect(asked).toHaveLength(3);
  });

  it('stops for good once the budget is spent', async () => {
    const h = harness();
    const asked: string[] = [];
    const persist = createKVPersistStorage<Prefs>('account', {
      kv: h.kv,
      onWriteRefused: (name) => void asked.push(name),
      recoveryBackoffMs: [0, 0],
    });

    h.kv.failGet = true;
    await persist.getItem(NAME);
    await persist.setItem(NAME, { state: { nickname: 'a' } });
    await flushTasks();
    await flushTasks();
    await flushTasks();

    expect(asked).toHaveLength(2);
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
