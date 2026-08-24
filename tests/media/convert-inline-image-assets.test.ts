import { describe, expect, test, vi } from 'vitest';
import type { AssetMeta } from '@openmaic/dsl';

import {
  convertInlineImageAssets,
  decodeInlineImageDataUrl,
  estimateInlineImageDecodedBytes,
  INLINE_IMAGE_SLIDE_CONCURRENCY,
  InlineImageConversionAbortedError,
  type InlineImageConversionDeps,
  MAX_INLINE_IMAGE_DECODED_BYTES,
} from '@/lib/media/convert-inline-image-assets';
import { buildStageAssetReclamationPlan } from '@/lib/media/reclaim-stage-assets';
import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';
import type { AppDocument } from '@/lib/document-store/persistence-types';
import type { Action } from '@/lib/types/action';
import type { AppScene, Stage } from '@/lib/types/stage';
import type { MediaFileRecord } from '@/lib/utils/database';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let allocationCounter = 0;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeHarness() {
  const pool = new Map<string, { blob: Blob; meta: AssetMeta }>();
  const mediaRows = new Map<string, MediaFileRecord>();

  const deps: InlineImageConversionDeps = {
    putAsset: async (blob, meta) => {
      const id = `ast_test_${(allocationCounter += 1)}`;
      pool.set(id, { blob, meta });
      return id;
    },
    removeAsset: async (ref) => {
      pool.delete(ref);
    },
    putMediaRecord: async (stageId, ref, record) => {
      mediaRows.set(`${stageId}:${ref}`, { ...record, id: `${stageId}:${ref}`, stageId });
    },
    // Deterministic digest over the DECODED bytes, so the dedup behavior is
    // directly observable (identical bytes in different encodings collapse).
    digest: async (bytes) => bytesToHex(bytes),
  };

  return { pool, mediaRows, deps };
}

function pngDataUrl(payload: string): string {
  return `data:image/png;base64,${btoa(payload)}`;
}

function imageElement(src: string, id = 'el'): Record<string, unknown> {
  return { id, type: 'image', src, left: 0, top: 0, width: 100, height: 100, rotate: 0 };
}

function stage(partial: Partial<Stage> = {}): Stage {
  return { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 2, ...partial };
}

function slideScene(actions: Action[] = [], elements: unknown[] = []): AppScene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene',
    order: 0,
    content: { type: 'slide', canvas: { id: 'canvas-1', elements } },
    actions,
    createdAt: 1,
    updatedAt: 2,
  } as AppScene;
}

function document(partial: Partial<AppDocument> = {}): AppDocument {
  return { stage: stage(), scenes: [], ...partial };
}

function canvasElements(doc: AppDocument): Array<{ src: string }> {
  return (
    (doc.scenes[0].content as { canvas: { elements: { src: string }[] } }).canvas.elements ?? []
  );
}

// ---------------------------------------------------------------------------
// Data URL decoding
// ---------------------------------------------------------------------------

describe('decodeInlineImageDataUrl', () => {
  test('decodes a base64 payload to its exact bytes and MIME type', () => {
    const decoded = decodeInlineImageDataUrl(pngDataUrl('hello'));
    expect(decoded).not.toBeNull();
    expect(decoded?.mimeType).toBe('image/png');
    expect(new TextDecoder().decode(decoded?.bytes)).toBe('hello');
  });

  test('decodes a percent-encoded UTF-8 payload to its exact bytes', () => {
    // Non-ASCII text proves the bytes are the true UTF-8 encoding, not the
    // UTF-16 code units of the decoded string.
    const src = `data:image/svg+xml,${encodeURIComponent('<text>déjà-vu ☃</text>')}`;
    const decoded = decodeInlineImageDataUrl(src);
    expect(decoded).not.toBeNull();
    expect(decoded?.mimeType).toBe('image/svg+xml');
    expect(new TextDecoder().decode(decoded?.bytes)).toBe('<text>déjà-vu ☃</text>');
    // The byte length is the UTF-8 length, not the character count: 'é'/'à'
    // are 2 bytes each and '☃' is 3, so the multi-byte payload proves the
    // percent path preserves UTF-8 exactly.
    expect(decoded?.bytes.length).toBe(new TextEncoder().encode('<text>déjà-vu ☃</text>').length);
  });

  test('tolerates whitespace inside a base64 payload', () => {
    const wrapped = `data:image/png;base64,${btoa('abc').slice(0, 2)}\n${btoa('abc').slice(2)}`;
    const decoded = decodeInlineImageDataUrl(wrapped);
    expect(new TextDecoder().decode(decoded?.bytes)).toBe('abc');
  });

  test('returns null for non-image data URLs and malformed payloads', () => {
    expect(decodeInlineImageDataUrl('data:text/plain;base64,AAAA')).toBeNull();
    expect(decodeInlineImageDataUrl('data:image/png;base64,!!!not-base64!!!')).toBeNull();
    expect(decodeInlineImageDataUrl('https://example.com/i.png')).toBeNull();
  });

  test('the ;base64 marker follows the fetch spec: case- and space-tolerant, final parameter only', () => {
    const payload = btoa('round-trip');
    // Every casing/space variant the fetch spec accepts decodes as base64 and
    // round-trips byte-exact.
    for (const marker of [';base64', ';BASE64', ';BaSe64', '; base64', ';  base64']) {
      const decoded = decodeInlineImageDataUrl(`data:image/png${marker},${payload}`);
      expect(decoded).not.toBeNull();
      expect(decoded?.mimeType).toBe('image/png');
      expect(new TextDecoder().decode(decoded?.bytes)).toBe('round-trip');
    }
    // A ;base64 that is NOT the final parameter is not a marker: the browser
    // percent-decodes the body and the image is broken either way, so the
    // value is conservatively kept rather than decoded on a guess.
    expect(decodeInlineImageDataUrl(`data:image/png;base64;charset=utf-8,${payload}`)).toBeNull();
    // Percent-encoded without a marker still converts via the percent path.
    const percent = decodeInlineImageDataUrl(
      `data:image/png;charset=utf-8,${encodeURIComponent('<svg/>')}`,
    );
    expect(percent).not.toBeNull();
    expect(new TextDecoder().decode(percent?.bytes)).toBe('<svg/>');
  });

  test('estimateInlineImageDecodedBytes measures DECODED bytes, not text length', () => {
    // Base64: text × 3/4, padding excluded (each quartet encodes 3 bytes).
    expect(estimateInlineImageDecodedBytes(pngDataUrl('hello'))).toBe(5);
    expect(estimateInlineImageDecodedBytes(`data:image/png;base64,${btoa('hello')}`)).toBe(5);
    // 'AA==' is 4 text chars, 2 padding → 1 decoded byte.
    expect(estimateInlineImageDecodedBytes('data:image/png;base64,AA==')).toBe(1);
    // Percent-encoded: the raw text length is a safe upper bound on the
    // decoded size (each `%XX` triple decodes to one byte).
    expect(estimateInlineImageDecodedBytes('data:image/svg+xml,%3Csvg%2F%3E')).toBe(12);
    // Non-inline values have no estimate.
    expect(estimateInlineImageDecodedBytes('https://example.com/i.png')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inline image conversion
// ---------------------------------------------------------------------------

describe('inline base64 image conversion', () => {
  test('a canvas image data URL is rewritten to an allocated pool id', async () => {
    const { pool, deps } = makeHarness();
    const doc = document({
      scenes: [slideScene([], [imageElement(pngDataUrl('bytes'))])],
    });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.changed).toBe(true);
    const src = canvasElements(result.document)[0].src;
    expect(src).toMatch(/^ast_test_/);
    expect(pool.has(src)).toBe(true);
    expect(pool.get(src)?.meta).toMatchObject({
      contentType: 'image/png',
      mediaType: 'image',
      origin: 'inline-data-url',
    });
    expect(await pool.get(src)?.blob.text()).toBe('bytes');
    expect(result.report.converted).toBe(1);
    expect(result.report.ingested).toBe(1);
    // The input document is never mutated.
    expect(canvasElements(doc)[0].src).toBe(pngDataUrl('bytes'));
  });

  test('identical base64 on N slides collapses to one id with N references', async () => {
    const { pool, deps } = makeHarness();
    const dataUrl = pngDataUrl('same-bytes');
    const doc = document({
      stage: stage({
        whiteboard: [
          { id: 'wb1', elements: [imageElement(dataUrl, 'wb1-el')] },
          { id: 'wb2', elements: [imageElement(dataUrl, 'wb2-el')] },
        ] as unknown as Stage['whiteboard'],
      }),
      scenes: [
        slideScene([], [imageElement(dataUrl, 'canvas-el'), imageElement(dataUrl, 'canvas-el-2')]),
      ],
    });

    const result = await convertInlineImageAssets(doc, deps);

    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    expect(result.report.converted).toBe(4);
    expect(result.report.ingested).toBe(1);
    const canvas = (
      result.document.scenes[0].content as {
        canvas: { elements: { src: string }[] };
      }
    ).canvas;
    expect(canvas.elements[0].src).toBe(assetId);
    expect(canvas.elements[1].src).toBe(assetId);
    expect(result.document.stage.whiteboard?.[0].elements[0]).toMatchObject({ src: assetId });
    expect(result.document.stage.whiteboard?.[1].elements[0]).toMatchObject({ src: assetId });
  });

  test('identical decoded bytes in different encodings collapse to one id', async () => {
    const { pool, deps } = makeHarness();
    const base64Encoded = `data:image/svg+xml;base64,${btoa('<svg/>')}`;
    const percentEncoded = `data:image/svg+xml,${encodeURIComponent('<svg/>')}`;
    const doc = document({
      scenes: [
        slideScene([], [imageElement(base64Encoded, 'a'), imageElement(percentEncoded, 'b')]),
      ],
    });

    const result = await convertInlineImageAssets(doc, deps);

    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    expect(canvasElements(result.document).map((el) => el.src)).toEqual([assetId, assetId]);
    expect(result.report.ingested).toBe(1);
    expect(result.report.converted).toBe(2);
  });

  test('concurrent slides naming one image share a single in-flight allocation', async () => {
    const { pool, deps } = makeHarness();
    const dataUrl = pngDataUrl('shared');
    const slowPut: InlineImageConversionDeps['putAsset'] = async (blob, meta) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const id = `ast_test_${(allocationCounter += 1)}`;
      pool.set(id, { blob, meta });
      return id;
    };
    const doc = document({
      stage: stage({
        whiteboard: [
          { id: 'wb1', elements: [imageElement(dataUrl)] },
          { id: 'wb2', elements: [imageElement(dataUrl)] },
          { id: 'wb3', elements: [imageElement(dataUrl)] },
        ] as unknown as Stage['whiteboard'],
      }),
    });

    const result = await convertInlineImageAssets(doc, { ...deps, putAsset: slowPut });

    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    for (const slide of result.document.stage.whiteboard ?? []) {
      expect(slide.elements[0]).toMatchObject({ src: assetId });
    }
  });

  test('whiteboard and background slots convert, not just canvas images', async () => {
    const { deps } = makeHarness();
    const bgUrl = pngDataUrl('background');
    const wbUrl = pngDataUrl('whiteboard');
    const doc = document({
      stage: stage({
        whiteboard: [
          {
            id: 'wb',
            background: { type: 'image', image: { src: bgUrl, size: 'cover' } },
            elements: [imageElement(wbUrl, 'wb-el')],
          },
        ] as unknown as Stage['whiteboard'],
      }),
      scenes: [
        {
          ...slideScene(),
          content: {
            type: 'slide',
            canvas: {
              id: 'canvas-1',
              background: { type: 'image', image: { src: bgUrl, size: 'cover' } },
              elements: [],
            },
          },
        } as unknown as AppScene,
      ],
    });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.report.converted).toBe(3);
    const canvas = (
      result.document.scenes[0].content as {
        canvas: { background: { image: { src: string } } };
      }
    ).canvas;
    const wb = result.document.stage.whiteboard?.[0];
    expect(canvas.background.image.src).toMatch(/^ast_test_/);
    expect((wb?.background as { image: { src: string } }).image.src).toMatch(/^ast_test_/);
    // Same bytes on the canvas background and the whiteboard background → one id.
    expect(canvas.background.image.src).toBe(
      (wb?.background as { image: { src: string } }).image.src,
    );
    expect((wb?.elements[0] as { src: string }).src).toMatch(/^ast_test_/);
  });

  test('video poster data URLs convert like image srcs', async () => {
    const { deps } = makeHarness();
    const doc = document({
      scenes: [
        slideScene(
          [],
          [
            {
              id: 'v1',
              type: 'video',
              src: 'ast_existing_video',
              mediaRef: 'ast_existing_video',
              poster: pngDataUrl('poster-bytes'),
            },
          ],
        ),
      ],
    });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.changed).toBe(true);
    const video = (
      result.document.scenes[0].content as {
        canvas: { elements: Array<{ src: string; poster: string }> };
      }
    ).canvas.elements[0];
    expect(video.src).toBe('ast_existing_video'); // untouched
    expect(video.poster).toMatch(/^ast_test_/);
    expect(result.report.converted).toBe(1);
  });

  test('second run is a no-op (idempotency)', async () => {
    const { pool, deps } = makeHarness();
    const doc = document({
      scenes: [slideScene([], [imageElement(pngDataUrl('bytes'))])],
    });

    const once = await convertInlineImageAssets(doc, deps);
    expect(once.changed).toBe(true);
    const allocationsAfterFirst = pool.size;
    const twice = await convertInlineImageAssets(once.document, deps);

    expect(twice.changed).toBe(false);
    expect(twice.document).toBe(once.document);
    expect(twice.report.converted).toBe(0);
    expect(pool.size).toBe(allocationsAfterFirst);
  });

  test('non-data-URL shapes are untouched (ids, gen_*, http, classroom-media, blob)', async () => {
    const { pool, deps } = makeHarness();
    const shapes = [
      'ast_allocated',
      'gen_img_alpha_001',
      'https://example.com/i.png',
      '/api/classroom-media/c1/i.png',
      'blob:http://localhost/abc',
    ];
    const doc = document({
      scenes: [
        slideScene(
          [],
          shapes.map((src, index) => imageElement(src, `el${index}`)),
        ),
      ],
    });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(result.report.converted).toBe(0);
    expect(result.report.kept).toBe(0);
    expect(pool.size).toBe(0);
    expect(canvasElements(result.document).map((el) => el.src)).toEqual(shapes);
  });

  test('a malformed data URL stays inline and counts as kept', async () => {
    const { pool, deps } = makeHarness();
    const malformed = 'data:image/png;base64,!!!not-base64!!!';
    const doc = document({ scenes: [slideScene([], [imageElement(malformed)])] });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(result.report.kept).toBe(1);
    expect(pool.size).toBe(0);
  });

  test('a failed ingest leaves that slot inline and does not stop the pass', async () => {
    const { pool, deps } = makeHarness();
    let calls = 0;
    const flakyPut: InlineImageConversionDeps['putAsset'] = async (blob, meta) => {
      calls += 1;
      if (calls === 1) throw new Error('pool down');
      const id = `ast_test_${(allocationCounter += 1)}`;
      pool.set(id, { blob, meta });
      return id;
    };
    const doc = document({
      scenes: [
        slideScene(
          [],
          [imageElement(pngDataUrl('one'), 'a'), imageElement(pngDataUrl('two'), 'b')],
        ),
      ],
    });

    const result = await convertInlineImageAssets(doc, { ...deps, putAsset: flakyPut });

    expect(result.changed).toBe(true);
    expect(result.report.converted).toBe(1);
    expect(result.report.kept).toBe(1);
    expect(canvasElements(result.document)[0].src).toBe(pngDataUrl('one')); // failed stays inline
    expect(canvasElements(result.document)[1].src).toMatch(/^ast_test_/); // pass continued
    expect(pool.size).toBe(1);
  });

  test('a failed putAsset forgets the memo entry so a sibling slot with the same bytes retries and converts', async () => {
    const { pool, deps } = makeHarness();
    let calls = 0;
    const flakyPut: InlineImageConversionDeps['putAsset'] = async (blob, meta) => {
      calls += 1;
      if (calls === 1) throw new Error('pool down');
      const id = `ast_test_${(allocationCounter += 1)}`;
      pool.set(id, { blob, meta });
      return id;
    };
    const src = pngDataUrl('same-bytes');
    const doc = document({
      scenes: [slideScene([], [imageElement(src, 'a'), imageElement(src, 'b')])],
    });

    const result = await convertInlineImageAssets(doc, { ...deps, putAsset: flakyPut });

    // Slot 1's pool write failed; the memo entry was forgotten, so slot 2
    // (identical bytes) retried instead of inheriting the rejected promise
    // for the rest of the pass.
    expect(result.changed).toBe(true);
    expect(result.report.converted).toBe(1);
    expect(result.report.ingested).toBe(1);
    expect(result.report.kept).toBe(1);
    expect(canvasElements(result.document)[0].src).toBe(src); // failed stays inline
    expect(canvasElements(result.document)[1].src).toMatch(/^ast_test_/); // sibling retried
    expect(pool.size).toBe(1);
  });

  test('a compatibility-write failure releases the allocated id and leaves the slot inline', async () => {
    const { pool, deps } = makeHarness();
    const failingPutMedia: InlineImageConversionDeps['putMediaRecord'] = async () => {
      throw new Error('dexie down');
    };
    const doc = document({ scenes: [slideScene([], [imageElement(pngDataUrl('bytes'))])] });

    const result = await convertInlineImageAssets(doc, {
      ...deps,
      putMediaRecord: failingPutMedia,
    });

    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(result.report.kept).toBe(1);
    // The failed attempt released its allocation: no stranded pool entry.
    expect(pool.size).toBe(0);
  });

  test('fresh allocations are reported on the ledger for caller rollback', async () => {
    const { pool, deps } = makeHarness();
    const ledger: string[] = [];
    const doc = document({
      scenes: [
        slideScene([], [imageElement(pngDataUrl('a'), 'a'), imageElement(pngDataUrl('b'), 'b')]),
      ],
    });

    const result = await convertInlineImageAssets(doc, deps, undefined, ledger);

    expect(result.changed).toBe(true);
    expect(ledger).toHaveLength(2);
    expect(pool.size).toBe(2);
    // A caller that discards the converted document releases every fresh
    // allocation — the accounting the shared rollback helper is built on.
    for (const id of ledger) await deps.removeAsset(id);
    expect(pool.size).toBe(0);
  });

  test('converted ids are stage-referenced assets: counted and reclaimed like part-2 images', async () => {
    const { pool, mediaRows, deps } = makeHarness();
    const dataUrl = pngDataUrl('same');
    const doc = document({
      stage: stage({
        whiteboard: [
          { id: 'wb', elements: [imageElement(dataUrl, 'wb-el')] },
        ] as unknown as Stage['whiteboard'],
      }),
      scenes: [slideScene([], [imageElement(dataUrl, 'canvas-el')])],
    });

    const result = await convertInlineImageAssets(doc, deps);
    const [assetId] = [...pool.keys()];

    const stageRows = [...mediaRows.values()].map(({ id, stageId }) => ({ id, stageId }));
    const refs = collectStageAssetRefs(result.document, {
      mediaRows: stageRows,
      audioRows: [],
    });

    // Counted exactly like a part-2 id-addressed image: referenced by the
    // document, and pool-owned through the compatibility row.
    expect(refs.document.has(assetId)).toBe(true);
    expect(refs.referenced.has(assetId)).toBe(true);
    expect(refs.referenceCounts.get(assetId)).toBe(2);
    expect(refs.poolOwned.has(assetId)).toBe(true);

    // Stage deletion builds a reclamation plan that includes the converted id.
    const plan = buildStageAssetReclamationPlan('stage-1', refs, stageRows, []);
    expect(plan.poolRefs).toContain(assetId);
  });

  test('a converted document converts the whole traversal, including scene whiteboards', async () => {
    const { deps } = makeHarness();
    const scene = slideScene([], [imageElement(pngDataUrl('canvas'), 'c')]);
    scene.whiteboards = [{ id: 'swb', elements: [imageElement(pngDataUrl('swb'), 's')] }] as never;
    const doc = document({ scenes: [scene] });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.report.converted).toBe(2);
    const convertedScene = result.document.scenes[0] as AppScene;
    expect(
      (convertedScene.content as { canvas: { elements: { src: string }[] } }).canvas.elements[0]
        .src,
    ).toMatch(/^ast_test_/);
    expect((convertedScene.whiteboards?.[0].elements[0] as { src: string }).src).toMatch(
      /^ast_test_/,
    );
  });

  test('fetch-spec ;base64 marker variants convert and round-trip byte-exact', async () => {
    const { pool, deps } = makeHarness();
    const payload = 'round-trip-bytes';
    const variants = [
      `data:image/png;base64,${btoa(payload)}`,
      `data:image/png;BASE64,${btoa(payload)}`,
      `data:image/png;BaSe64,${btoa(payload)}`,
      `data:image/png; base64,${btoa(payload)}`,
      `data:image/png;  base64,${btoa(payload)}`,
    ];
    const doc = document({
      scenes: [
        slideScene(
          [],
          variants.map((src, index) => imageElement(src, `el${index}`)),
        ),
      ],
    });

    const result = await convertInlineImageAssets(doc, deps);

    // All five variants decode the same bytes → one allocation, five refs.
    expect(result.changed).toBe(true);
    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    expect(await pool.get(assetId)?.blob.text()).toBe(payload);
    expect(canvasElements(result.document).map((el) => el.src)).toEqual(
      variants.map(() => assetId),
    );
    expect(result.report.converted).toBe(5);
  });

  test('a ;base64 that is not the final parameter is kept, never converted', async () => {
    const { pool, deps } = makeHarness();
    const src = `data:image/png;base64;charset=utf-8,${btoa('not-this')}`;
    const doc = document({ scenes: [slideScene([], [imageElement(src)])] });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(result.report.kept).toBe(1);
    expect(pool.size).toBe(0);
  });

  test('safe-direction marker shapes stay inline: never rewritten into a guessed decode', async () => {
    const { pool, deps } = makeHarness();
    const payload = btoa('never-decoded');
    // Shapes whose fetch-spec handling differs from a naive base64 guess. The
    // converter must leave each inline (the safe direction) rather than
    // decode a body the browser treats differently:
    // - leading space after `data:` (the spec strips it → base64; the
    //   converter does not even recognize the value as an inline data URL);
    // - trailing space after the `;base64` marker (the spec strips it →
    //   base64; the converter's stray-token guard keeps it);
    // - NBSP inside the marker (the spec percent-decodes; the stray-token
    //   guard keeps it — never a base64 guess).
    const shapes = [
      `data: image/png;base64,${payload}`,
      `data:image/png;base64 ,${payload}`,
      `data:image/png;\u00a0base64,${payload}`,
    ];
    const doc = document({
      scenes: [
        slideScene(
          [],
          shapes.map((src, index) => imageElement(src, `el${index}`)),
        ),
      ],
    });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(pool.size).toBe(0);
    expect(canvasElements(result.document).map((el) => el.src)).toEqual(shapes);
    // The two shapes the converter recognizes as inline are counted as kept;
    // the leading-space shape is not even recognized as inline and is left
    // untouched, uncounted.
    expect(result.report.converted).toBe(0);
    expect(result.report.kept).toBe(2);
  });

  test('an unavailable content digest degrades the pass to a no-op with one warn', async () => {
    const { pool, deps } = makeHarness();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // A non-secure context / older webview: crypto.subtle is undefined and
      // the default digest throws TypeError on first use.
      const unavailableDeps: InlineImageConversionDeps = {
        ...deps,
        digest: async () => {
          throw new TypeError('crypto.subtle is undefined');
        },
      };
      const doc = document({
        scenes: [
          slideScene([], [imageElement(pngDataUrl('a'), 'a'), imageElement(pngDataUrl('b'), 'b')]),
        ],
      });

      const result = await convertInlineImageAssets(doc, unavailableDeps);

      expect(result.changed).toBe(false);
      expect(result.document).toBe(doc);
      expect(result.report.converted).toBe(0);
      expect(result.report.ingested).toBe(0);
      expect(result.report.kept).toBe(2);
      expect(result.allocatedIds).toEqual([]);
      expect(pool.size).toBe(0);
      const digestWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('digest unavailable'),
      );
      expect(digestWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a mid-run digest failure keeps that slot inline and the pass continues', async () => {
    const { pool, deps } = makeHarness();
    const failingDigest: InlineImageConversionDeps['digest'] = async (bytes) => {
      const hex = bytesToHex(bytes);
      if (hex === bytesToHex(new TextEncoder().encode('boom'))) throw new Error('digest hiccup');
      return hex;
    };
    const doc = document({
      scenes: [
        slideScene(
          [],
          [
            imageElement(pngDataUrl('ok-1'), 'a'),
            imageElement(pngDataUrl('boom'), 'b'),
            imageElement(pngDataUrl('ok-2'), 'c'),
          ],
        ),
      ],
    });

    const result = await convertInlineImageAssets(doc, { ...deps, digest: failingDigest });

    expect(result.changed).toBe(true);
    expect(result.report.converted).toBe(2);
    expect(result.report.kept).toBe(1);
    const srcs = canvasElements(result.document).map((el) => el.src);
    expect(srcs[0]).toMatch(/^ast_test_/);
    expect(srcs[1]).toBe(pngDataUrl('boom'));
    expect(srcs[2]).toMatch(/^ast_test_/);
    expect(pool.size).toBe(2);
  });

  test('zero-byte payloads stay inline: no allocation, no compatibility row', async () => {
    const { pool, mediaRows, deps } = makeHarness();
    const doc = document({
      scenes: [
        slideScene([], [imageElement('data:image/png;base64,'), imageElement('data:image/png,')]),
      ],
    });

    const result = await convertInlineImageAssets(doc, deps);

    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(result.report.kept).toBe(2);
    expect(pool.size).toBe(0);
    expect(mediaRows.size).toBe(0);
  });

  test('an abort mid-pass stops the pass immediately and the ledger carries exactly the pre-abort allocations', async () => {
    const { pool, deps } = makeHarness();
    const ledger: string[] = [];
    let digestCalls = 0;
    let putAssetCalls = 0;
    const countingDeps: InlineImageConversionDeps = {
      ...deps,
      digest: async (bytes) => {
        digestCalls += 1;
        return bytesToHex(bytes);
      },
      putAsset: async (blob, meta) => {
        putAssetCalls += 1;
        const id = `ast_test_${(allocationCounter += 1)}`;
        pool.set(id, { blob, meta });
        return id;
      },
    };
    // Liveness holds for the slide-start check and slot 1's commit boundary,
    // then fails at slot 2's commit boundary — after slot 2's bytes were
    // ingested but before its mirror write.
    let livenessCalls = 0;
    const shouldContinue = () => ++livenessCalls < 3;
    const doc = document({
      scenes: [
        slideScene(
          [],
          [
            imageElement(pngDataUrl('one'), 'a'),
            imageElement(pngDataUrl('two'), 'b'),
            imageElement(pngDataUrl('three'), 'c'),
          ],
        ),
      ],
    });

    await expect(
      convertInlineImageAssets(doc, countingDeps, shouldContinue, ledger),
    ).rejects.toThrow(InlineImageConversionAbortedError);

    // Slot 3 was never touched: the abort stopped the pass immediately.
    expect(digestCalls).toBe(3); // availability probe + slot 1 + slot 2
    expect(putAssetCalls).toBe(2); // slot 1 + slot 2 (slot 2's putAsset precedes its commit check)
    expect(ledger).toHaveLength(2); // exactly the pre-abort allocations
    expect(pool.size).toBe(1); // slot 2's allocation was compensated on abort
    // The input document is never mutated even by the aborted pass.
    expect(canvasElements(doc)[0].src).toBe(pngDataUrl('one'));
  });

  test('an oversized inline payload is kept without decoding', async () => {
    const { pool, deps } = makeHarness();
    let digestCalls = 0;
    const countingDeps: InlineImageConversionDeps = {
      ...deps,
      digest: async (bytes) => {
        digestCalls += 1;
        return bytesToHex(bytes);
      },
    };
    // Base64 text long enough that its DECODED size exceeds the 50 MB cap
    // (the estimate scales text by 3/4, so the text must be ~4/3 × the cap).
    const oversized = `data:image/png;base64,${'A'.repeat(
      Math.ceil(((MAX_INLINE_IMAGE_DECODED_BYTES + 1) * 4) / 3),
    )}`;
    const doc = document({ scenes: [slideScene([], [imageElement(oversized)])] });

    const result = await convertInlineImageAssets(doc, countingDeps);

    expect(result.changed).toBe(false);
    expect(result.document).toBe(doc);
    expect(result.report.kept).toBe(1);
    expect(pool.size).toBe(0);
    // The pre-decode gate fired: no digest — and so no decode — was attempted.
    expect(digestCalls).toBe(0);
  });

  test('a payload whose raw text exceeds the cap but DECODES under it converts', async () => {
    const { pool, deps } = makeHarness();
    // Base64 text longer than MAX_INLINE_IMAGE_DECODED_BYTES (the old gate
    // compared TEXT length, so it kept this) decodes to only ~3/4 of that —
    // under the 50 MB byte cap — so the pre-decode DECODED-size estimate
    // lets it through. The length is a multiple of 4 so atob accepts it.
    const textLength = MAX_INLINE_IMAGE_DECODED_BYTES + 4;
    const src = `data:image/png;base64,${'A'.repeat(textLength)}`;
    const doc = document({ scenes: [slideScene([], [imageElement(src)])] });

    const result = await convertInlineImageAssets(doc, {
      ...deps,
      // One unique payload: a length-addressed digest avoids hex-encoding the
      // ~39 MB buffer the harness's byte digest would materialize.
      digest: async (bytes) => `len:${bytes.length}`,
    });

    expect(result.changed).toBe(true);
    expect(result.report.converted).toBe(1);
    expect(result.report.ingested).toBe(1);
    expect(result.report.kept).toBe(0);
    expect(pool.size).toBe(1);
    const [assetId] = [...pool.keys()];
    expect(canvasElements(result.document)[0].src).toBe(assetId);
    // 'A' is the base64 encoding of a zero byte: decoded size = text × 3/4.
    expect(pool.get(assetId)?.blob.size).toBe((textLength * 3) / 4);
  }, 30_000);

  test('oversized payloads are reported with ONE aggregate warn per pass', async () => {
    const { pool, deps } = makeHarness();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const oversized = `data:image/png;base64,${'A'.repeat(
        Math.ceil(((MAX_INLINE_IMAGE_DECODED_BYTES + 1) * 4) / 3),
      )}`;
      const doc = document({
        scenes: [slideScene([], [imageElement(oversized, 'a'), imageElement(oversized, 'b')])],
      });

      const result = await convertInlineImageAssets(doc, deps);

      expect(result.changed).toBe(false);
      expect(result.report.kept).toBe(2);
      expect(pool.size).toBe(0);
      // The old per-payload warn repeated once per oversized payload per open;
      // the fix reports the whole pass in one aggregate message.
      const oversizedWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0]).includes('oversized'),
      );
      expect(oversizedWarns).toHaveLength(1);
      expect(String(oversizedWarns[0][0])).toContain('2 oversized inline image payloads');
      expect(String(oversizedWarns[0][0])).toContain(String(MAX_INLINE_IMAGE_DECODED_BYTES));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('whiteboard slides convert with bounded concurrency (batch 4)', async () => {
    const { pool, deps } = makeHarness();
    let inFlight = 0;
    let maxInFlight = 0;
    const slowDigest: InlineImageConversionDeps['digest'] = async (bytes) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return bytesToHex(bytes);
    };
    const slides = Array.from({ length: 9 }, (_, index) => ({
      id: `wb-${index}`,
      elements: [imageElement(pngDataUrl(`img-${index}`), `el-${index}`)],
    }));
    const doc = document({
      stage: stage({ whiteboard: slides as unknown as Stage['whiteboard'] }),
    });

    const result = await convertInlineImageAssets(doc, { ...deps, digest: slowDigest });

    expect(result.changed).toBe(true);
    expect(result.report.converted).toBe(9);
    expect(pool.size).toBe(9);
    expect(maxInFlight).toBeLessThanOrEqual(INLINE_IMAGE_SLIDE_CONCURRENCY);
  });
});

// ---------------------------------------------------------------------------
// Time budget
// ---------------------------------------------------------------------------

describe('conversion time budget', () => {
  test('budget expiry mid-run keeps progress and the next open continues', async () => {
    vi.useFakeTimers();
    try {
      const { pool, deps } = makeHarness();
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const slowPut: InlineImageConversionDeps['putAsset'] = async (blob, meta) => {
        await gate;
        const id = `ast_test_${(allocationCounter += 1)}`;
        pool.set(id, { blob, meta });
        return id;
      };
      const doc = document({
        scenes: [
          slideScene(
            [],
            [imageElement(pngDataUrl('one'), 'a'), imageElement(pngDataUrl('two'), 'b')],
          ),
        ],
      });

      const pending = convertInlineImageAssets(doc, { ...deps, putAsset: slowPut });
      // Exhaust the 15-second aggregate budget while the first ingest is still
      // pending (a stalled pool write).
      vi.advanceTimersByTime(16_000);
      releaseFirst();
      const first = await pending;

      // The conversions made before expiry are kept; the rest stay inline.
      expect(first.changed).toBe(true);
      expect(first.report.converted).toBe(1);
      expect(first.report.ingested).toBe(1);
      expect(first.report.kept).toBe(1);
      expect(canvasElements(first.document)[0].src).toMatch(/^ast_test_/);
      expect(canvasElements(first.document)[1].src).toBe(pngDataUrl('two'));

      // The next open continues from where the budget stopped it.
      const second = await convertInlineImageAssets(first.document, deps);
      expect(second.changed).toBe(true);
      expect(second.report.converted).toBe(1);
      expect(canvasElements(second.document)[1].src).toMatch(/^ast_test_/);
      expect(pool.size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
