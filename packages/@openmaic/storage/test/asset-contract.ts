// Implementation-agnostic contract for a `StorageProvider` (the DSL-owned asset
// seam). `resolve` yields a URL whose *bytes* must equal what was `put`; how a
// URL is read back differs per backend (object URL vs HTTP), so the reader is
// injected, keeping the assertions universal across backends.
import { describe, expect, test } from 'vitest';
import type { StorageProvider } from '@openmaic/dsl';

type ReadUrl = (url: string) => Promise<Uint8Array>;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
// Build the Blob from the string directly (a string is a valid BlobPart). A
// `Uint8Array` BlobPart trips TS 5.7+'s `Uint8Array<ArrayBufferLike>` vs
// `ArrayBufferView<ArrayBuffer>` narrowing under the root tsconfig; the bytes
// are UTF-8 either way, so `bytes(s)` stays the source of truth for comparison.
const blob = (s: string, type = 'text/plain'): Blob => new Blob([s], { type });

export function runStorageProviderContract(
  name: string,
  makeProvider: () => StorageProvider,
  readUrl: ReadUrl,
): void {
  describe(`StorageProvider contract: ${name}`, () => {
    test('put returns a non-empty ref', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('hello'));
      expect(typeof ref).toBe('string');
      expect(ref.length).toBeGreaterThan(0);
    });

    test('is content-addressed: identical bytes yield the same ref', async () => {
      const p = makeProvider();
      const a = await p.put(blob('same-content'));
      const b = await p.put(blob('same-content'));
      expect(a).toBe(b);
    });

    test('distinct bytes yield distinct refs', async () => {
      const p = makeProvider();
      const a = await p.put(blob('one'));
      const b = await p.put(blob('two'));
      expect(a).not.toBe(b);
    });

    test('resolve yields a URL whose bytes equal the stored blob', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('round-trip me'));
      const url = await p.resolve(ref);
      expect(url).not.toBeNull();
      expect(await readUrl(url!)).toEqual(bytes('round-trip me'));
    });

    test('concurrent resolve of the same ref yields one shared URL', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('shared'));
      // Two in-flight resolves must not each mint a URL (the second would orphan
      // the first, which only `remove` could ever revoke). They share one.
      const [a, b] = await Promise.all([p.resolve(ref), p.resolve(ref)]);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });

    test('resolve returns null for an unknown ref', async () => {
      const p = makeProvider();
      expect(await p.resolve('sha256-deadbeef')).toBeNull();
    });

    test('resolve returns null after remove', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('temporary'));
      await p.remove(ref);
      expect(await p.resolve(ref)).toBeNull();
    });
  });
}
