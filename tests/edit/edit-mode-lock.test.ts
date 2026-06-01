import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  editLockKey,
  isEditLockHeldByOther,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  readEditLock,
  refreshEditLock,
  releaseEditLock,
  tryAcquireEditLock,
} from '@/lib/edit/edit-mode-lock';

class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  getItem(k: string) {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null;
  }
}

let original: typeof globalThis.localStorage | undefined;

beforeEach(() => {
  original = (globalThis as { localStorage?: typeof globalThis.localStorage }).localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: original,
    configurable: true,
    writable: true,
  });
});

describe('editLockKey', () => {
  it('is scoped per course id', () => {
    expect(editLockKey('course-A')).not.toBe(editLockKey('course-B'));
  });
});

describe('tryAcquireEditLock', () => {
  it('grants the lock when nothing is held', () => {
    expect(tryAcquireEditLock('c1', 'tab-A')).toBe(true);
    expect(readEditLock('c1')?.tabId).toBe('tab-A');
  });

  it('grants the lock when our own tab already holds it', () => {
    tryAcquireEditLock('c1', 'tab-A', 1000);
    expect(tryAcquireEditLock('c1', 'tab-A', 2000)).toBe(true);
    expect(readEditLock('c1')?.timestamp).toBe(2000);
  });

  it('refuses when another tab holds a fresh lock', () => {
    tryAcquireEditLock('c1', 'tab-A', 1000);
    expect(tryAcquireEditLock('c1', 'tab-B', 1000 + LOCK_HEARTBEAT_MS)).toBe(false);
    // Original owner unchanged.
    expect(readEditLock('c1')?.tabId).toBe('tab-A');
  });

  it('steals a stale lock from a crashed tab past LOCK_STALE_MS', () => {
    tryAcquireEditLock('c1', 'tab-A', 1000);
    expect(tryAcquireEditLock('c1', 'tab-B', 1000 + LOCK_STALE_MS + 1)).toBe(true);
    expect(readEditLock('c1')?.tabId).toBe('tab-B');
  });

  it('does not bleed across courses', () => {
    tryAcquireEditLock('c1', 'tab-A');
    expect(tryAcquireEditLock('c2', 'tab-B')).toBe(true);
  });
});

describe('isEditLockHeldByOther', () => {
  it('returns false when nobody holds the lock', () => {
    expect(isEditLockHeldByOther('c1', 'tab-A')).toBe(false);
  });

  it('returns false when our tab holds the lock', () => {
    tryAcquireEditLock('c1', 'tab-A');
    expect(isEditLockHeldByOther('c1', 'tab-A')).toBe(false);
  });

  it('returns true when another tab holds a fresh lock', () => {
    tryAcquireEditLock('c1', 'tab-A', 1000);
    expect(isEditLockHeldByOther('c1', 'tab-B', 1000 + LOCK_HEARTBEAT_MS)).toBe(true);
  });

  it("returns false when the other tab's lock is stale", () => {
    tryAcquireEditLock('c1', 'tab-A', 1000);
    expect(isEditLockHeldByOther('c1', 'tab-B', 1000 + LOCK_STALE_MS + 1)).toBe(false);
  });
});

describe('refreshEditLock', () => {
  it('updates the timestamp for our tab', () => {
    tryAcquireEditLock('c1', 'tab-A', 1000);
    refreshEditLock('c1', 'tab-A', 5000);
    expect(readEditLock('c1')?.timestamp).toBe(5000);
  });

  it("does not overwrite another tab's lock", () => {
    tryAcquireEditLock('c1', 'tab-A', 1000);
    refreshEditLock('c1', 'tab-B', 2000);
    expect(readEditLock('c1')?.tabId).toBe('tab-A');
    expect(readEditLock('c1')?.timestamp).toBe(1000);
  });
});

describe('releaseEditLock', () => {
  it('removes the lock when we own it', () => {
    tryAcquireEditLock('c1', 'tab-A');
    releaseEditLock('c1', 'tab-A');
    expect(readEditLock('c1')).toBeNull();
  });

  it('is a no-op when another tab owns the lock', () => {
    tryAcquireEditLock('c1', 'tab-A');
    releaseEditLock('c1', 'tab-B');
    expect(readEditLock('c1')?.tabId).toBe('tab-A');
  });

  it('is a no-op when no lock exists', () => {
    expect(() => releaseEditLock('c1', 'tab-A')).not.toThrow();
  });
});

describe('graceful degradation', () => {
  it('returns null when stored JSON is corrupted', () => {
    localStorage.setItem(editLockKey('c1'), '{not json');
    expect(readEditLock('c1')).toBeNull();
  });

  it('returns null when stored shape is wrong', () => {
    localStorage.setItem(editLockKey('c1'), JSON.stringify({ wrong: 'shape' }));
    expect(readEditLock('c1')).toBeNull();
  });
});
