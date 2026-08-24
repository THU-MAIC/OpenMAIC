import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { SceneOutline } from '@/lib/types/generation';

const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());
const resolveVisionImagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  callLLM: callLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

vi.mock('@/lib/persistence/resolve-vision-images', () => ({
  resolveVisionImagesForPrompt: resolveVisionImagesMock,
}));

// The route's resolve-with-refill phase budget reuses the shared 15 s ingest
// constant; the hanging-store test injects a tiny budget through this mock so
// the aggregate budget is observable without waiting 15 s (the same injection
// the extraction-cache test uses for `assetProbeBudgetMs`). Every other test
// in this file resolves its probes instantly, so the small budget never fires.
vi.mock('@/lib/document/extract-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/document/extract-source')>();
  return { ...actual, DEFAULT_INGEST_AWAIT_TIMEOUT_MS: 50 };
});

/**
 * Server-backed generation by allocated asset id (RFC #1153 part 2 B): the
 * client sends `imageMapping` as (image id → allocated asset id), the route
 * resolves those ids to bytes at prompt-assembly time (before
 * `buildVisionUserContent`), and `resolveImageIds` writes the ALLOCATED ID
 * into `PPTImageElement.src` for the renderer to resolve through the pool.
 */
describe('scene-content route — asset-id image transport', () => {
  beforeEach(() => {
    callLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveVisionImagesMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: { vision: true } },
      modelString: 'test:test-model',
      thinkingConfig: undefined,
    });
  });

  test('resolves asset ids to the same bytes the base64 path would send and writes the allocated id into src', async () => {
    vi.resetModules();
    // The vision slice reaches the route with the allocated id as its src.
    resolveVisionImagesMock.mockImplementation(async (images: Array<{ id: string; src: string }>) =>
      images.map((image) => ({
        ...image,
        src: `data:image/png;base64,${Buffer.from('resolved-bytes').toString('base64')}`,
      })),
    );
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({
        elements: [
          {
            type: 'image',
            src: 'img_1',
            left: 100,
            top: 100,
            width: 400,
            height: 300,
            rotate: 0,
          },
        ],
        remark: '',
      }),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({
        outline: slideOutline(),
        pdfImages: [{ id: 'img_1', src: '', pageNumber: 1, width: 100, height: 100 }],
        imageMapping: { img_1: 'ast_allocated_image_0001' },
      }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    // The prompt-assembly resolution was asked for the allocated id.
    expect(resolveVisionImagesMock).toHaveBeenCalledWith(
      [
        {
          id: 'img_1',
          src: 'ast_allocated_image_0001',
          width: 100,
          height: 100,
        },
      ],
      expect.anything(),
    );
    // The LLM received the resolved bytes (same content the base64 path would
    // send — `buildVisionUserContent` strips the data-URL prefix).
    const messages = callLLMMock.mock.calls[0][0].messages;
    const imagePart = messages[0].content.find((part: { type: string }) => part.type === 'image');
    expect(imagePart).toMatchObject({
      type: 'image',
      image: Buffer.from('resolved-bytes').toString('base64'),
      mimeType: 'image/png',
    });
    // The generated element's src is the ALLOCATED ID, resolved by the
    // renderer through the pool registry.
    expect(body.content.elements[0].src).toBe('ast_allocated_image_0001');
  });

  test('passes data URLs through untouched on a browser-backed request', async () => {
    vi.resetModules();
    const dataUrl = `data:image/png;base64,${Buffer.from('browser-bytes').toString('base64')}`;
    resolveVisionImagesMock.mockImplementation(
      async (images: Array<{ id: string; src: string }>) => images,
    );
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({
        elements: [
          {
            type: 'image',
            src: 'img_1',
            left: 100,
            top: 100,
            width: 400,
            height: 300,
            rotate: 0,
          },
        ],
        remark: '',
      }),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({
        outline: slideOutline(),
        pdfImages: [{ id: 'img_1', src: dataUrl, pageNumber: 1, width: 100, height: 100 }],
        imageMapping: { img_1: dataUrl },
      }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    // The data-URL payload reaches the resolver verbatim (pass-through), so
    // the LLM content is byte-identical to the pre-part-2 path.
    expect(resolveVisionImagesMock).toHaveBeenCalledWith(
      [{ id: 'img_1', src: dataUrl, width: 100, height: 100 }],
      expect.anything(),
    );
    expect(body.content.elements[0].src).toBe(dataUrl);
  });

  test('drops an unresolvable image from BOTH the prompt text and the attachments (N3)', async () => {
    vi.resetModules();
    // The pre-resolution drops img_2 (the server cannot resolve its id);
    // img_1 resolves to bytes, data URLs pass through.
    resolveVisionImagesMock.mockImplementation(async (images: Array<{ id: string; src: string }>) =>
      images
        .filter((image) => image.src !== 'ast_gone')
        .map((image) => ({
          ...image,
          src: image.src.startsWith('data:')
            ? image.src
            : `data:image/png;base64,${Buffer.from(`bytes-for-${image.id}`).toString('base64')}`,
        })),
    );
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({
        elements: [
          {
            type: 'image',
            src: 'img_1',
            left: 100,
            top: 100,
            width: 400,
            height: 300,
            rotate: 0,
          },
        ],
        remark: '',
      }),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({
        outline: slideOutline(['img_1', 'img_2']),
        pdfImages: [
          { id: 'img_1', src: '', pageNumber: 1, width: 100, height: 100 },
          { id: 'img_2', src: '', pageNumber: 2, width: 200, height: 100 },
        ],
        imageMapping: { img_1: 'ast_ok', img_2: 'ast_gone' },
      }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    // The prompt text promised `[see attached]` only for img_1 — img_2's
    // text mention is gone with its attachment (no dangling promise).
    const content = callLLMMock.mock.calls[0][0].messages[0].content;
    const textPart = content.find((part: { type: string }) => part.type === 'text');
    expect(textPart.text).toContain('img_1');
    expect(textPart.text).toContain('[see attached]');
    expect(textPart.text).not.toContain('img_2');
    // Only img_1's bytes were attached.
    const imageParts = content.filter((part: { type: string }) => part.type === 'image');
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0].image).toBe(Buffer.from('bytes-for-img_1').toString('base64'));
    // The surviving image still resolves to the ALLOCATED ID in the element
    // src (part 2 B transport preserved).
    expect(body.content.elements[0].src).toBe('ast_ok');
  });

  test('handles a MIXED imageMapping (allocated ids AND data URLs) in one request (N4)', async () => {
    vi.resetModules();
    const dataUrl = `data:image/png;base64,${Buffer.from('browser-bytes').toString('base64')}`;
    resolveVisionImagesMock.mockImplementation(async (images: Array<{ id: string; src: string }>) =>
      images.map((image) => ({
        ...image,
        src: image.src.startsWith('data:')
          ? image.src
          : `data:image/png;base64,${Buffer.from('resolved-bytes').toString('base64')}`,
      })),
    );
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({
        elements: [
          {
            type: 'image',
            src: 'img_1',
            left: 100,
            top: 100,
            width: 400,
            height: 300,
            rotate: 0,
          },
          {
            type: 'image',
            src: 'img_2',
            left: 100,
            top: 420,
            width: 400,
            height: 300,
            rotate: 0,
          },
        ],
        remark: '',
      }),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({
        outline: slideOutline(['img_1', 'img_2']),
        pdfImages: [
          { id: 'img_1', src: '', pageNumber: 1, width: 100, height: 100 },
          { id: 'img_2', src: dataUrl, pageNumber: 2, width: 200, height: 100 },
        ],
        imageMapping: { img_1: 'ast_mixed_1', img_2: dataUrl },
      }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    // The LLM received both images (id resolved, data URL passed through).
    const content = callLLMMock.mock.calls[0][0].messages[0].content;
    const imageParts = content.filter((part: { type: string }) => part.type === 'image');
    expect(imageParts).toHaveLength(2);
    // resolveImageIds writes each mapping value verbatim: the allocated id
    // stays an id, the data URL stays a data URL — the renderer resolves both.
    expect(body.content.elements[0].src).toBe('ast_mixed_1');
    expect(body.content.elements[1].src).toBe(dataUrl);
  });

  test('multi-drop: refills the vision slice with RESOLVED candidates so no promise dangles (P2)', async () => {
    vi.resetModules();
    const dataUrlFor = (bytes: string) =>
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    // 25 candidates (> MAX_VISION_IMAGES = 20); img_2, img_7 and img_15 are
    // unresolvable. The old N3 filter dropped them and let the generator
    // re-slice img_21..img_23 in UNRESOLVED; the refill must admit them WITH
    // their resolution — every `[see attached]` promise has an attachment.
    resolveVisionImagesMock.mockImplementation(async (images: Array<{ id: string; src: string }>) =>
      images
        .filter((image) => image.src !== 'ast_gone')
        .map((image) => ({ ...image, src: dataUrlFor(`bytes-for-${image.id}`) })),
    );
    const ids = Array.from({ length: 25 }, (_, i) => `img_${i + 1}`);
    const gone = new Set(['img_2', 'img_7', 'img_15']);
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({
        elements: [
          { type: 'image', src: 'img_1', left: 100, top: 100, width: 400, height: 300, rotate: 0 },
        ],
        remark: '',
      }),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({
        outline: slideOutline(ids),
        pdfImages: ids.map((id, index) => ({
          id,
          src: '',
          pageNumber: index + 1,
          width: 100,
          height: 100,
        })),
        imageMapping: Object.fromEntries(
          ids.map((id) => [id, gone.has(id) ? 'ast_gone' : `ast_${id}`]),
        ),
      }),
    );
    const body = await response.json();
    expect(body.success).toBe(true);

    const content = callLLMMock.mock.calls[0][0].messages[0].content;
    const textPart = content.find((part: { type: string }) => part.type === 'text');
    const text = textPart.text as string;
    // The dropped ids are gone from the text entirely (no dangling mention).
    // Word-boundary matched: `img_2` must not match inside the refilled
    // `img_21`..`img_23`.
    for (const id of gone) {
      expect(text).not.toMatch(new RegExp(`\\b${id}\\b`));
    }
    // Exactly 20 `[see attached]` promises — one per attachment, no more.
    expect(text.match(/\[see attached\]/g)).toHaveLength(20);
    // Every attachment is the RESOLVED bytes of a surviving candidate, in
    // generator order — including the REFILLED img_21..img_23 (which the old
    // filter would have admitted unresolved).
    const expectedResolved = ids.filter((id) => !gone.has(id)).slice(0, 20);
    const imageParts = content.filter((part: { type: string }) => part.type === 'image');
    expect(imageParts).toHaveLength(20);
    imageParts.forEach((part: { image: string }, index: number) => {
      expect(part.image).toBe(
        Buffer.from(`bytes-for-${expectedResolved[index]}`).toString('base64'),
      );
    });
    for (const refilled of ['img_21', 'img_22', 'img_23']) {
      expect(text).toContain(`**${refilled}**`);
      expect(text).toContain('[see attached]');
    }
    // The surviving element still resolves to its ALLOCATED id (B transport).
    expect(body.content.elements[0].src).toBe('ast_img_1');
  });

  test('all-unresolvable fast-fail: the consecutive-failure fuse stops probing after 3 and generation proceeds text-only (P2-r3)', async () => {
    vi.resetModules();
    // Every candidate unresolvable, INSTANTLY (a fast-failing store). Without
    // a fuse the loop would churn through ALL 25 candidates sequentially (one
    // probe + one warn each); the fuse must stop after 3 consecutive failures
    // and degrade to text-only generation — never fail the request.
    const { ids, pdfImages, imageMapping } = manyCandidateImages(25);
    resolveVisionImagesMock.mockResolvedValue([]);
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({ elements: [], remark: '' }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({ outline: slideOutline(ids), pdfImages, imageMapping }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    // The fuse tripped after exactly 3 probes — the other 22 were never
    // probed (no N-warn churn).
    expect(resolveVisionImagesMock).toHaveBeenCalledTimes(3);
    // Generation proceeded with an empty resolved set: text-only (the aiCall
    // sees no vision images, so callLLM gets a plain `prompt`), no dangling
    // `[see attached]` promise.
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const prompt = callLLMMock.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain('[see attached]');
    expect(callLLMMock.mock.calls[0][0].messages).toBeUndefined();
    // ONE summary warn names the fuse (the per-candidate warns are collapsed).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('consecutive-failure fuse');
    warn.mockRestore();
  });

  test('hanging store: the aggregate resolution budget stops the phase within the bound, no hang (P2-r3)', async () => {
    vi.resetModules();
    // The store accepts the probe but never answers — a stalled database with
    // no statement timeout. Each probe would otherwise hold the route until
    // the platform cap; the aggregate phase budget (the mocked 50 ms below,
    // the shared 15 s constant in production) must stop the phase within the
    // bound and degrade to text-only generation.
    const { ids, pdfImages, imageMapping } = manyCandidateImages(25);
    resolveVisionImagesMock.mockImplementation(() => new Promise(() => undefined));
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({ elements: [], remark: '' }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({ outline: slideOutline(ids), pdfImages, imageMapping }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    // Only the FIRST candidate was probed before the budget fired.
    expect(resolveVisionImagesMock).toHaveBeenCalledTimes(1);
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const prompt = callLLMMock.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain('[see attached]');
    expect(callLLMMock.mock.calls[0][0].messages).toBeUndefined();
    // ONE summary warn names the budget.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('aggregate resolution budget');
    warn.mockRestore();
  });

  test('hallucinated reference to a DROPPED id removes the element (no dangling src, P3)', async () => {
    vi.resetModules();
    const dataUrlFor = (bytes: string) =>
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    resolveVisionImagesMock.mockImplementation(async (images: Array<{ id: string; src: string }>) =>
      images
        .filter((image) => image.src !== 'ast_gone')
        .map((image) => ({ ...image, src: dataUrlFor(`bytes-for-${image.id}`) })),
    );
    // The model hallucinates a reference to img_2, which the route dropped
    // (its allocated id does not resolve server-side — a reclaimed asset).
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({
        elements: [
          { type: 'image', src: 'img_1', left: 100, top: 100, width: 400, height: 300, rotate: 0 },
          { type: 'image', src: 'img_2', left: 100, top: 420, width: 400, height: 300, rotate: 0 },
        ],
        remark: '',
      }),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({
        outline: slideOutline(['img_1', 'img_2']),
        pdfImages: [
          { id: 'img_1', src: '', pageNumber: 1, width: 100, height: 100 },
          { id: 'img_2', src: '', pageNumber: 2, width: 200, height: 100 },
        ],
        imageMapping: { img_1: 'ast_ok', img_2: 'ast_gone' },
      }),
    );
    const body = await response.json();
    expect(body.success).toBe(true);

    // img_2 was STRIPPED from the mapping passed to the generator, so
    // resolveImageIds takes the clean "no mapping → remove element" path
    // instead of writing the dangling allocated id into src.
    expect(body.content.elements).toHaveLength(1);
    expect(body.content.elements[0].src).toBe('ast_ok');
  });

  test('browser-backed mode is unaffected: >cap data-URL images all keep their promises', async () => {
    vi.resetModules();
    const dataUrlFor = (bytes: string) =>
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    // Data URLs pass through the resolver untouched — nothing can drop.
    resolveVisionImagesMock.mockImplementation(
      async (images: Array<{ id: string; src: string }>) => images,
    );
    const ids = Array.from({ length: 25 }, (_, i) => `img_${i + 1}`);
    callLLMMock.mockResolvedValueOnce({
      text: JSON.stringify({
        elements: [
          { type: 'image', src: 'img_1', left: 100, top: 100, width: 400, height: 300, rotate: 0 },
        ],
        remark: '',
      }),
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      mockRequest({
        outline: slideOutline(ids),
        pdfImages: ids.map((id, index) => ({
          id,
          src: '',
          pageNumber: index + 1,
          width: 100,
          height: 100,
        })),
        imageMapping: Object.fromEntries(ids.map((id) => [id, dataUrlFor(id)])),
      }),
    );
    const body = await response.json();
    expect(body.success).toBe(true);

    const content = callLLMMock.mock.calls[0][0].messages[0].content;
    const textPart = content.find((part: { type: string }) => part.type === 'text');
    // The same 20 + 5 split as before part 2: 20 attached, 5 plain text.
    expect((textPart.text as string).match(/\[see attached\]/g)).toHaveLength(20);
    const imageParts = content.filter((part: { type: string }) => part.type === 'image');
    expect(imageParts).toHaveLength(20);
    imageParts.forEach((part: { image: string }, index: number) => {
      expect(part.image).toBe(Buffer.from(ids[index]).toString('base64'));
    });
    // The element src is the data URL verbatim, exactly as before.
    expect(body.content.elements[0].src).toBe(dataUrlFor('img_1'));
  });
});

function mockRequest(body: {
  outline: SceneOutline;
  pdfImages?: Array<{
    id: string;
    src: string;
    pageNumber: number;
    width?: number;
    height?: number;
  }>;
  imageMapping?: Record<string, string>;
}) {
  return {
    json: async () => ({
      outline: body.outline,
      allOutlines: [body.outline],
      stageId: 'stage-1',
      stageInfo: { name: 'Test Stage' },
      pdfImages: body.pdfImages ?? [],
      imageMapping: body.imageMapping ?? {},
    }),
    headers: {
      get: () => null,
    },
  } as unknown as Parameters<typeof import('@/app/api/generate/scene-content/route').POST>[0];
}

function slideOutline(suggestedImageIds: string[] = ['img_1']): SceneOutline {
  return {
    id: 'scene-slide',
    type: 'slide',
    title: 'Safety Checklist',
    description: 'Inspect the device before calibration.',
    keyPoints: ['Inspect', 'Calibrate'],
    order: 1,
    suggestedImageIds,
  };
}

/** `count` assigned images with distinct allocated ids and page numbers. */
function manyCandidateImages(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `img_${i + 1}`);
  return {
    ids,
    pdfImages: ids.map((id, index) => ({
      id,
      src: '',
      pageNumber: index + 1,
      width: 100,
      height: 100,
    })),
    imageMapping: Object.fromEntries(ids.map((id) => [id, `ast_${id}`])),
  };
}
