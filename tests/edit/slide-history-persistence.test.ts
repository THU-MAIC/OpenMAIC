import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistedSlideHistory,
  hasPersistedSlideHistory,
  loadPersistedSlideHistory,
  persistSlideHistory,
  slideHistoryStorageKey,
} from '@/lib/edit/slide-history-persistence';
import type { SlideEditHistory } from '@/lib/edit/slide-ops';
import type { SlideContent } from '@/lib/types/stage';

function makeContent(): SlideContent {
  return {
    type: 'slide',
    canvas: {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#000000'],
        fontColor: '#000000',
        fontName: 'sans-serif',
      },
      elements: [],
    },
  };
}

function makeHistory(): SlideEditHistory {
  return {
    past: [],
    present: makeContent(),
    future: [],
  };
}

// Minimal in-memory localStorage shim — Node 18+ test env doesn't include
// the Web Storage API by default. Restored in afterEach.
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

let originalLocalStorage: typeof globalThis.localStorage | undefined;

beforeEach(() => {
  originalLocalStorage = (globalThis as { localStorage?: typeof globalThis.localStorage })
    .localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: originalLocalStorage,
    configurable: true,
    writable: true,
  });
});

describe('slideHistoryStorageKey', () => {
  it('is scoped per scene id', () => {
    expect(slideHistoryStorageKey('scene-A')).not.toBe(slideHistoryStorageKey('scene-B'));
  });

  it('includes a stable prefix so callers can detect editor-owned keys', () => {
    expect(slideHistoryStorageKey('scene-A')).toMatch(/^maic-editor:slide-history:/);
  });
});

describe('persist / load round-trip', () => {
  it('returns null when no history is stored for the scene', () => {
    expect(loadPersistedSlideHistory('scene-A')).toBeNull();
    expect(hasPersistedSlideHistory('scene-A')).toBe(false);
  });

  it('round-trips a history through localStorage', () => {
    const history = makeHistory();
    persistSlideHistory('scene-A', history);
    expect(hasPersistedSlideHistory('scene-A')).toBe(true);
    expect(loadPersistedSlideHistory('scene-A')).toEqual(history);
  });

  it('does not bleed across scene ids', () => {
    persistSlideHistory('scene-A', makeHistory());
    expect(hasPersistedSlideHistory('scene-B')).toBe(false);
    expect(loadPersistedSlideHistory('scene-B')).toBeNull();
  });

  it('clearPersistedSlideHistory removes the entry', () => {
    persistSlideHistory('scene-A', makeHistory());
    clearPersistedSlideHistory('scene-A');
    expect(hasPersistedSlideHistory('scene-A')).toBe(false);
  });
});

describe('graceful degradation', () => {
  it('returns null when JSON in storage is corrupted', () => {
    localStorage.setItem(slideHistoryStorageKey('scene-A'), '{not json');
    expect(loadPersistedSlideHistory('scene-A')).toBeNull();
  });

  it('swallows storage write failures without throwing', () => {
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => persistSlideHistory('scene-A', makeHistory())).not.toThrow();
    setItem.mockRestore();
  });
});
