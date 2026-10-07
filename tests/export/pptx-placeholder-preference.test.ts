import { describe, expect, it } from 'vitest';
import {
  PPTX_PLACEHOLDERS_STORAGE_KEY,
  readIncludePptxPlaceholders,
  writeIncludePptxPlaceholders,
} from '@/lib/export/pptx-placeholder-preference';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('PPTX placeholder preference', () => {
  it('defaults to on', () => {
    expect(readIncludePptxPlaceholders(memoryStorage())).toBe(true);
    expect(readIncludePptxPlaceholders(null)).toBe(true);
  });

  it('persists the choice per browser', () => {
    const storage = memoryStorage();
    writeIncludePptxPlaceholders(false, storage);
    expect(storage.values.get(PPTX_PLACEHOLDERS_STORAGE_KEY)).toBe('false');
    expect(readIncludePptxPlaceholders(storage)).toBe(false);
    writeIncludePptxPlaceholders(true, storage);
    expect(readIncludePptxPlaceholders(storage)).toBe(true);
  });

  it('falls back to the default when storage is unavailable', () => {
    expect(readIncludePptxPlaceholders(throwingStorage)).toBe(true);
    expect(() => writeIncludePptxPlaceholders(false, throwingStorage)).not.toThrow();
  });

  it('treats an unexpected stored value as on', () => {
    expect(
      readIncludePptxPlaceholders(memoryStorage({ [PPTX_PLACEHOLDERS_STORAGE_KEY]: 'yes' })),
    ).toBe(true);
  });
});
