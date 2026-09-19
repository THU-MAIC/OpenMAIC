// Implementation-agnostic contract for the DSL-owned `StorageProvider` seam,
// whose refs are allocated ids. `resolve` yields a URL whose bytes must equal
// what was `put`; how a URL is read back differs per backend (object URL vs
// HTTP), so the reader is injected, keeping the assertions universal. A browser
// implementation may deduplicate its private byte rows, but identical bytes
// must never share a caller-visible id.
import { describe, expect, test } from 'vitest';
import type { AssetMeta, AssetRef, StorageProvider } from '@openmaic/dsl';
import { toAssetId, type AssetId } from '../src/asset/id.js';

type ReadUrl = (url: string) => Promise<Uint8Array>;

interface AssetStoreContractFactories {
  makeStore: () => StorageProvider;
  withAllocator: <T>(allocator: () => AssetId, run: () => Promise<T>) => Promise<T>;
}

interface ReplaceCapableStore extends StorageProvider {
  replace: (ref: AssetId, data: Blob, meta?: AssetMeta) => Promise<void>;
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
// Build the Blob from the string directly (a string is a valid BlobPart). A
// `Uint8Array` BlobPart trips TS 5.7+'s `Uint8Array<ArrayBufferLike>` vs
// `ArrayBufferView<ArrayBuffer>` narrowing under the root tsconfig; the bytes
// are UTF-8 either way, so `bytes(s)` stays the source of truth for comparison.
const blob = (s: string, type = 'text/plain'): Blob => new Blob([s], { type });

// These are the base32 renderings of six fixed 16-byte inputs.
const SCRIPTED_ASSET_IDS = [
  'ast_00000000000000000000000000',
  'ast_040g2081040g2081040g208104',
  'ast_081040g2081040g2081040g208',
  'ast_0c1g60r30c1g60r30c1g60r30c',
  'ast_0g2081040g2081040g2081040g',
  'ast_0m2ga1850m2ga1850m2ga1850m',
].map(toAssetId);

interface ScriptedAllocator {
  ids: readonly AssetId[];
  factory: () => AssetId;
  draws: () => number;
}

function scriptedAllocator(count: number): ScriptedAllocator {
  const ids = SCRIPTED_ASSET_IDS.slice(0, count);
  if (ids.length !== count) throw new Error('Not enough scripted asset ids.');

  let draws = 0;
  return {
    ids,
    factory: () => {
      const id = ids[draws];
      draws += 1;
      if (id === undefined) throw new Error('Scripted asset id allocator exhausted.');
      return id;
    },
    draws: () => draws,
  };
}

async function runHistory(
  makeStore: AssetStoreContractFactories['makeStore'],
  withAllocator: AssetStoreContractFactories['withAllocator'],
  history: readonly string[],
  inspect?: (
    store: StorageProvider,
    ids: readonly AssetRef[],
    allocator: ScriptedAllocator,
  ) => Promise<void>,
): Promise<AssetRef[]> {
  const allocator = scriptedAllocator(history.length);
  return withAllocator(allocator.factory, async () => {
    const store = makeStore();
    const ids: AssetRef[] = [];
    for (const [ordinal, content] of history.entries()) {
      const id = await store.put(blob(content));
      expect(id).toBe(allocator.ids[ordinal]);
      ids.push(id);
      expect(allocator.draws()).toBe(ids.length);
    }

    expect(ids).toEqual(allocator.ids);
    expect(allocator.draws()).toBe(ids.length);
    await inspect?.(store, ids, allocator);
    return ids;
  });
}

function base32(digest: Uint8Array, alphabet: string): string {
  let encoded = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) encoded += alphabet[(accumulator << (5 - bits)) & 31];
  return encoded;
}

export async function commonDigestEncodings(data: Blob): Promise<string[]> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await data.arrayBuffer()));
  const binary = String.fromCharCode(...digest);
  const base64 = btoa(binary);
  return [
    Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase(),
    base32(digest, '0123456789ABCDEFGHJKMNPQRSTVWXYZ'),
    base32(digest, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
    base64,
    base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  ];
}

export async function expectNoDigestSubstring(id: AssetRef, data: Blob): Promise<void> {
  const minimumLeakLength = 12;
  for (const encoding of await commonDigestEncodings(data)) {
    for (const idForm of new Set([id, id.toLowerCase()])) {
      for (const encodingForm of new Set([encoding, encoding.toLowerCase()])) {
        for (let start = 0; start <= encodingForm.length - minimumLeakLength; start += 1) {
          expect(idForm).not.toContain(encodingForm.slice(start, start + minimumLeakLength));
        }
      }
    }
  }
}

/**
 * Ids a caller might hand back that the store never issued. Every one must be
 * an ordinary miss — the id domain is opaque and unvalidated, so there is no
 * such thing as a malformed id, only an id nothing is stored under.
 */
export const FOREIGN_IDS: ReadonlyArray<readonly [label: string, id: string]> = [
  ['empty string', ''],
  ['whitespace', '   '],
  ['bare prefix', 'ast_'],
  ['4 KiB of padding', `ast_${'x'.repeat(4096)}`],
  ['bucket/path shape', 'bucket/path/to/object.png'],
  ['legacy content-addressed ref', 'sha256-deadbeefdeadbeefdeadbeefdeadbeef'],
  ['embedded NUL', 'ast_before\u0000after'],
  ['path traversal shape', '../../etc/passwd'],
  ['non-ASCII', 'ast_\u00e9-\u4e2d-\ud83d\ude00'],
  ['newline', 'ast_a\nb'],
];

/**
 * Everything a caller can observe about one `put` and the id it returns. The
 * existence-disclosure matrix compares two of these — one whose bytes were
 * already in the pool, one whose bytes were new — facet by facet.
 */
interface PutObservation {
  putOutcome: string;
  idType: string;
  idPrefix: string;
  idLength: number;
  idCollidesWithEarlierId: boolean;
  resolvesToUrl: boolean;
  resolvedBytesMatch: boolean;
  removeOutcome: string;
  resolvesAfterRemove: boolean;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    return `threw:${err instanceof Error ? err.name : typeof err}`;
  }
}

export function runAssetStoreContract(
  name: string,
  factories: AssetStoreContractFactories,
  readUrl: ReadUrl,
): void {
  const { makeStore, withAllocator } = factories;
  const putAll = (store: StorageProvider, content: string, times: number): Promise<AssetRef[]> =>
    Promise.all(Array.from({ length: times }, () => store.put(blob(content))));

  /** Resolve a ref and read the bytes back, or `null` when it is a miss. */
  const bytesAt = async (store: StorageProvider, ref: AssetRef): Promise<Uint8Array | null> => {
    const url = await store.resolve(ref);
    return url === null ? null : readUrl(url);
  };

  async function observePut(
    store: StorageProvider,
    content: string,
    seen: Set<string>,
  ): Promise<PutObservation> {
    let id: AssetRef | undefined;
    const putOutcome = await outcome(async () => {
      id = await store.put(blob(content));
    });
    const ref = id ?? '';
    const resolved = await bytesAt(store, ref);
    const observation: PutObservation = {
      putOutcome,
      idType: typeof id,
      idPrefix: ref.slice(0, 4),
      idLength: ref.length,
      idCollidesWithEarlierId: seen.has(ref),
      resolvesToUrl: resolved !== null,
      resolvedBytesMatch: resolved !== null && new TextDecoder().decode(resolved) === content,
      removeOutcome: await outcome(() => store.remove(ref)),
      resolvesAfterRemove: (await store.resolve(ref)) !== null,
    };
    seen.add(ref);
    return observation;
  }

  describe(`asset store contract: ${name}`, () => {
    test('put returns a non-empty id', async () => {
      const s = makeStore();
      const id = await s.put(blob('hello'));
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    test('allocated ids contain no digest substring in common encodings', async () => {
      const s = makeStore();
      const data = blob('digest independence');
      const id = await s.put(data);
      await expectNoDigestSubstring(id, data);
    });

    test('allocated id width is independent of payload size', async () => {
      const s = makeStore();
      const threeBytes = await s.put(blob('abc'));
      const sixtyFourKiB = await s.put(blob('x'.repeat(64 * 1024)));
      expect(threeBytes.length).toBe(sixtyFourKiB.length);
    });

    test('ids are allocated: identical bytes yield distinct ids', async () => {
      const s = makeStore();
      const [a, b] = await putAll(s, 'same-content', 2);
      expect(a).not.toBe(b);
    });

    test('every put allocates: N puts of identical bytes yield N distinct ids', async () => {
      const s = makeStore();
      const ids = await putAll(s, 'repeat me', 5);
      expect(new Set(ids).size).toBe(5);
    });

    test('distinct bytes yield distinct ids', async () => {
      const s = makeStore();
      const a = await s.put(blob('one'));
      const b = await s.put(blob('two'));
      expect(a).not.toBe(b);
    });

    test('each id of the same bytes resolves to those bytes', async () => {
      const s = makeStore();
      const [a, b] = await putAll(s, 'shared bytes', 2);
      expect(await bytesAt(s, a)).toEqual(bytes('shared bytes'));
      expect(await bytesAt(s, b)).toEqual(bytes('shared bytes'));
    });

    test('resolve yields a URL whose bytes equal the stored blob', async () => {
      const s = makeStore();
      const id = await s.put(blob('round-trip me'));
      const url = await s.resolve(id);
      expect(url).not.toBeNull();
      expect(await readUrl(url!)).toEqual(bytes('round-trip me'));
    });

    test('concurrent resolve of the same id yields one shared URL', async () => {
      const s = makeStore();
      const id = await s.put(blob('shared'));
      // Two in-flight resolves must not each mint a URL (the second would orphan
      // the first, which only `remove` could ever revoke). They share one.
      const [a, b] = await Promise.all([s.resolve(id), s.resolve(id)]);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });

    test('concurrent puts of identical bytes allocate distinct, resolvable ids', async () => {
      const s = makeStore();
      const ids = await putAll(s, 'racing bytes', 8);
      expect(new Set(ids).size).toBe(8);
      for (const id of ids) expect(await bytesAt(s, id)).toEqual(bytes('racing bytes'));
    });

    // Successful `put` calls must not disclose whether bytes already exist.
    // Resource-accounting failures are outside this comparison. Compare the
    // success path facet by facet so a newly discovered observable has to be
    // added to `PutObservation` to count as covered.
    test('successful put paths do not disclose whether bytes already existed', async () => {
      const s = makeStore();
      const seen = new Set<string>();
      // Seed so the next put of these bytes is a de-duplication hit...
      seen.add(await s.put(blob('pre-existing bytes')));
      const dedupeHit = await observePut(s, 'pre-existing bytes', seen);
      // ...compared against a put of bytes the store has never seen, at the
      // same call ordinal on the same store instance.
      const firstStore = await observePut(s, 'brand new bytes', seen);
      expect(dedupeHit).toEqual(firstStore);
      // Pin the expected values too, so two identically *broken* observations
      // could not agree their way to a pass.
      expect(dedupeHit).toMatchObject({
        putOutcome: 'ok',
        idType: 'string',
        idCollidesWithEarlierId: false,
        resolvesToUrl: true,
        resolvedBytesMatch: true,
        removeOutcome: 'ok',
        resolvesAfterRemove: false,
      });
    });

    describe('allocation independence', () => {
      test('ordinal 2 is byte-identical for duplicate and fresh puts', async () => {
        const duplicateAtTwo = await runHistory(makeStore, withAllocator, [
          'allocation A',
          'allocation A',
        ]);
        const freshAtTwo = await runHistory(makeStore, withAllocator, [
          'allocation A',
          'allocation B',
        ]);

        expect(duplicateAtTwo[1]).toBe(freshAtTwo[1]);
      });

      test('ordinal 3 is byte-identical for duplicate and fresh puts', async () => {
        const duplicateAtThree = await runHistory(makeStore, withAllocator, [
          'allocation A',
          'allocation B',
          'allocation A',
        ]);
        const freshAtThree = await runHistory(makeStore, withAllocator, [
          'allocation A',
          'allocation B',
          'allocation C',
        ]);

        expect(duplicateAtThree[2]).toBe(freshAtThree[2]);
      });

      test('every put returns exactly one allocator output regardless of prior existence', async () => {
        await runHistory(
          makeStore,
          withAllocator,
          [
            'allocation A', // fresh A
            'allocation A', // duplicate A
            'allocation B', // fresh B
            'allocation B', // duplicate B
            'allocation A', // duplicate A
            'allocation C', // fresh C
          ],
          async (store, ids, allocator) => {
            if (typeof (store as Partial<ReplaceCapableStore>).replace === 'function') {
              const drawsBeforeReplace = allocator.draws();
              await (store as ReplaceCapableStore).replace(
                ids[0] as AssetId,
                blob('allocation replacement'),
              );
              expect(allocator.draws()).toBe(drawsBeforeReplace);
              expect(await bytesAt(store, ids[0])).toEqual(bytes('allocation replacement'));
            }
          },
        );
      });
    });

    test('removing one id leaves the other ids of the same bytes resolvable', async () => {
      const s = makeStore();
      const [a, b] = await putAll(s, 'two owners', 2);
      await s.remove(a);
      expect(await s.resolve(a)).toBeNull();
      expect(await bytesAt(s, b)).toEqual(bytes('two owners'));
    });

    test('removing every id of some bytes leaves them unresolvable', async () => {
      const s = makeStore();
      const ids = await putAll(s, 'last reference', 3);
      for (const id of ids) await s.remove(id);
      for (const id of ids) expect(await s.resolve(id)).toBeNull();
    });

    test('remove is idempotent', async () => {
      const s = makeStore();
      const id = await s.put(blob('temporary'));
      await expect(s.remove(id)).resolves.toBeUndefined();
      await expect(s.remove(id)).resolves.toBeUndefined();
      expect(await s.resolve(id)).toBeNull();
    });

    test('removing one asset leaves an unrelated asset untouched', async () => {
      const s = makeStore();
      const a = await s.put(blob('doomed'));
      const b = await s.put(blob('bystander'));
      await s.remove(a);
      expect(await bytesAt(s, b)).toEqual(bytes('bystander'));
    });

    test('resolve returns null after remove', async () => {
      const s = makeStore();
      const id = await s.put(blob('temporary'));
      await s.remove(id);
      expect(await s.resolve(id)).toBeNull();
    });

    // The id domain is opaque and unvalidated: an id the store never issued is
    // a miss, never an error, whatever it looks like.
    describe('unknown ids are misses, not errors', () => {
      for (const [label, id] of FOREIGN_IDS) {
        test(`resolve is null and remove is a no-op for ${label}`, async () => {
          const s = makeStore();
          const kept = await s.put(blob('untouched'));
          expect(await s.resolve(id)).toBeNull();
          await expect(s.remove(id)).resolves.toBeUndefined();
          expect(await s.resolve(id)).toBeNull();
          // A foreign id must not collaterally disturb a real asset.
          expect(await bytesAt(s, kept)).toEqual(bytes('untouched'));
        });
      }
    });

    test('metadata does not merge assets: same bytes, different meta, two ids', async () => {
      const s = makeStore();
      const a = await s.put(blob('same pixels'), { contentType: 'image/png', alt: 'first' });
      const b = await s.put(blob('same pixels'), { contentType: 'image/png', alt: 'second' });
      expect(a).not.toBe(b);
      expect(await bytesAt(s, a)).toEqual(bytes('same pixels'));
      expect(await bytesAt(s, b)).toEqual(bytes('same pixels'));
    });

    test('meta is optional and an empty meta object is accepted', async () => {
      const s = makeStore();
      const empty: AssetMeta = {};
      const a = await s.put(blob('no meta'));
      const b = await s.put(blob('empty meta'), empty);
      expect(await bytesAt(s, a)).toEqual(bytes('no meta'));
      expect(await bytesAt(s, b)).toEqual(bytes('empty meta'));
    });
  });
}
