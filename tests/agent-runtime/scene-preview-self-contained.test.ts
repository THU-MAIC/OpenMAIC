import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { interactiveLibraryUrl } from '@openmaic/generation/browser';

import type { CourseStore } from '@/lib/server/agent-runtime/course-tools';
import { buildScenePreviewTools } from '@/lib/server/agent-runtime/scene-preview';
import {
  PREVIEW_REQUEST_BUDGET_BYTES,
  readHostedInteractiveLibraryFile,
  type PreviewAssetResolution,
} from '@/lib/server/agent-runtime/scene-preview-content';

/** A scene as sent in the `/preview` body. */
type PreviewScene = unknown;

interface RenderPreviewValidation {
  previewabilityError(scene: PreviewScene): string | undefined;
  findNonSelfContainedInteractiveReferences(html: string): string[];
}

// The render service's own validator: the request must pass the contract the
// service enforces, not a copy of it. It is loaded at run time because the
// render service is its own package with its own compiler settings.
let validation: RenderPreviewValidation;
const previewabilityError = (scene: PreviewScene) => validation.previewabilityError(scene);
const findNonSelfContainedInteractiveReferences = (html: string) =>
  validation.findNonSelfContainedInteractiveReferences(html);
beforeAll(async () => {
  validation = (await import(
    /* @vite-ignore */ fileURLToPath(
      new URL('../../render-service/src/preview-validation.ts', import.meta.url),
    )
  )) as RenderPreviewValidation;
});

const PNG = new Uint8Array([137, 80, 78, 71]);
const OWNER = 'user:owner-a';
const OTHER_OWNER = 'user:owner-b';
const IMAGE_ID = 'ast_nn28d9r7tysaj3cfz69z9k9gew';
const IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function slideScene(elements: unknown[], background?: unknown) {
  return {
    id: 'scene-a',
    stageId: 'stage-a',
    order: 1,
    title: 'A',
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas-a',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#ffffff',
          themeColors: ['#000000'],
          fontColor: '#000000',
          fontName: 'sans-serif',
        },
        elements,
        ...(background ? { background } : {}),
      },
    },
    actions: [],
  };
}

function image(id: string, src: string) {
  return { type: 'image', id, src, left: 0, top: 0, width: 200, height: 100, rotate: 0 };
}

function storeOf(scene: unknown): CourseStore {
  return {
    loadDocument: vi.fn(async () => ({
      stage: { id: 'stage-a', name: 'Stage A' },
      scenes: [scene],
    })),
  } as unknown as CourseStore;
}

/** An asset pool where each asset belongs to one owner. */
function assetPool(assets: Record<string, { owner: string; bytes: Buffer; mime: string }>) {
  return vi.fn(async (ownerId: string, assetId: string, maxByteLength: number) =>
    ((): PreviewAssetResolution => {
      const asset = assets[assetId];
      if (!asset || asset.owner !== ownerId) return { status: 'missing' };
      if (asset.bytes.byteLength > maxByteLength) return { status: 'too_large' };
      return { status: 'resolved', buffer: asset.bytes, mimeType: asset.mime };
    })(),
  );
}

function recordingRenderService(respond?: () => Response) {
  const bodies: Array<{ scene: PreviewScene }> = [];
  const fetchPreview = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return respond ? respond() : new Response(PNG);
  });
  return { bodies, fetchPreview: fetchPreview as unknown as typeof fetch };
}

function tool(options: {
  scene: unknown;
  ownerId?: string;
  readAsset?: ReturnType<typeof assetPool>;
  fetchPreview: typeof fetch;
}) {
  const [preview] = buildScenePreviewTools({
    store: storeOf(options.scene),
    stageAccess: async () => ({ kind: 'owned' as const }),
    ownerId: options.ownerId ?? OWNER,
    renderService: { url: 'http://render.test' },
    fetchPreview: options.fetchPreview,
    readAsset: options.readAsset ?? assetPool({}),
  });
  return preview!;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

describe('render_scene_preview self-contained scenes', () => {
  it('reproduces the refusal: a stored slide with an asset-id image is not previewable as is', () => {
    expect(previewabilityError(slideScene([image('img-1', IMAGE_ID)]) as PreviewScene)).toBe(
      'Scene is not self-contained: 1 slide media reference(s) must use data: URLs',
    );
  });

  it("inlines the owner's asset ids as data URLs the render service accepts, leaving the store untouched", async () => {
    const scene = slideScene(
      [
        image('img-1', IMAGE_ID),
        image('img-2', 'data:image/png;base64,AAAA'),
        {
          type: 'video',
          id: 'video-1',
          src: 'ast_video',
          poster: 'ast_poster',
          autoplay: false,
          left: 0,
          top: 0,
          width: 320,
          height: 180,
          rotate: 0,
        },
        { type: 'audio', id: 'audio-1', src: 'ast_audio', left: 0, top: 0, width: 50, height: 50 },
      ],
      { type: 'image', image: { src: 'ast_background', size: 'cover' } },
    );
    const stored = structuredClone(scene);
    const readAsset = assetPool({
      [IMAGE_ID]: { owner: OWNER, bytes: IMAGE_BYTES, mime: 'image/png' },
      ast_video: { owner: OWNER, bytes: Buffer.from('video'), mime: 'video/mp4' },
      ast_poster: { owner: OWNER, bytes: Buffer.from('poster'), mime: 'image/jpeg' },
      ast_audio: { owner: OWNER, bytes: Buffer.from('audio'), mime: 'audio/mpeg' },
      ast_background: { owner: OWNER, bytes: Buffer.from('bg'), mime: 'image/webp' },
    });
    const { bodies, fetchPreview } = recordingRenderService();

    const result = await tool({ scene, readAsset, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);

    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const sent = bodies[0]!.scene;
    expect(previewabilityError(sent)).toBeUndefined();
    const canvas = (sent as unknown as { content: { canvas: Record<string, unknown> } }).content
      .canvas;
    const elements = canvas.elements as Array<Record<string, unknown>>;
    expect(elements[0]!.src).toBe(`data:image/png;base64,${IMAGE_BYTES.toString('base64')}`);
    expect(elements[1]!.src).toBe('data:image/png;base64,AAAA');
    expect(elements[2]).toMatchObject({
      src: `data:video/mp4;base64,${Buffer.from('video').toString('base64')}`,
      poster: `data:image/jpeg;base64,${Buffer.from('poster').toString('base64')}`,
    });
    expect(elements[3]!.src).toMatch(/^data:audio\/mpeg;base64,/);
    expect(canvas.background).toMatchObject({
      image: { src: expect.stringMatching(/^data:image\/webp;/) },
    });
    // Every asset is read as the session owner.
    expect(readAsset.mock.calls.every(([ownerId]) => ownerId === OWNER)).toBe(true);
    expect(scene).toEqual(stored);
    expect(textOf(result)).toBe('');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['an opaque ref that mediaRef overrides', 'ast_stale_src'],
  ])('plays a video whose source is its mediaRef (src %s) from src', async (_label, src) => {
    const video = {
      type: 'video',
      id: 'video-1',
      ...(src === undefined ? {} : { src }),
      mediaRef: 'ast_video',
      autoplay: false,
      left: 0,
      top: 0,
      width: 320,
      height: 180,
      rotate: 0,
    };
    const scene = slideScene([video]);
    const stored = structuredClone(scene);
    const readAsset = assetPool({
      ast_video: { owner: OWNER, bytes: Buffer.from('video'), mime: 'video/mp4' },
      ast_stale_src: { owner: OWNER, bytes: Buffer.from('stale'), mime: 'video/mp4' },
    });
    const { bodies, fetchPreview } = recordingRenderService();

    const result = await tool({ scene, readAsset, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);

    expect(previewabilityError(bodies[0]!.scene)).toBeUndefined();
    const sent = (
      bodies[0]!.scene as { content: { canvas: { elements: Array<Record<string, unknown>> } } }
    ).content.canvas.elements[0]!;
    expect(sent.src).toBe(`data:video/mp4;base64,${Buffer.from('video').toString('base64')}`);
    expect(sent).not.toHaveProperty('mediaRef');
    expect(sent).not.toHaveProperty('poster');
    expect(readAsset.mock.calls.map(([, assetId]) => assetId)).toEqual(['ast_video']);
    expect(textOf(result)).toBe('');
    expect(scene).toEqual(stored);
  });

  it('ignores an empty mediaRef and plays the asset in src', async () => {
    const scene = slideScene([
      {
        type: 'video',
        id: 'video-1',
        src: 'ast_video',
        mediaRef: '',
        autoplay: false,
        left: 0,
        top: 0,
        width: 320,
        height: 180,
        rotate: 0,
      },
    ]);
    const readAsset = assetPool({
      ast_video: { owner: OWNER, bytes: Buffer.from('video'), mime: 'video/mp4' },
    });
    const { bodies, fetchPreview } = recordingRenderService();
    await tool({ scene, readAsset, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(previewabilityError(bodies[0]!.scene)).toBeUndefined();
    expect(
      (bodies[0]!.scene as { content: { canvas: { elements: Array<{ src: string }> } } }).content
        .canvas.elements[0]!.src,
    ).toBe(`data:video/mp4;base64,${Buffer.from('video').toString('base64')}`);
  });

  it('keeps a concrete video src over its mediaRef, as the player does', async () => {
    const scene = slideScene([
      {
        type: 'video',
        id: 'video-1',
        src: 'data:video/mp4;base64,AAAA',
        mediaRef: 'ast_video',
        autoplay: false,
        left: 0,
        top: 0,
        width: 320,
        height: 180,
        rotate: 0,
      },
    ]);
    const readAsset = assetPool({});
    const { bodies, fetchPreview } = recordingRenderService();
    await tool({ scene, readAsset, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(readAsset).not.toHaveBeenCalled();
    expect(previewabilityError(bodies[0]!.scene)).toBeUndefined();
    expect(
      (bodies[0]!.scene as { content: { canvas: { elements: Array<{ src: string }> } } }).content
        .canvas.elements[0]!.src,
    ).toBe('data:video/mp4;base64,AAAA');
  });

  it("never inlines another owner's asset: the slot is a placeholder and the agent is told", async () => {
    const scene = slideScene([image('img-1', IMAGE_ID)]);
    const readAsset = assetPool({
      [IMAGE_ID]: { owner: OTHER_OWNER, bytes: IMAGE_BYTES, mime: 'image/png' },
    });
    const { bodies, fetchPreview } = recordingRenderService();

    const result = await tool({ scene, readAsset, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);

    expect(readAsset).toHaveBeenCalledWith(OWNER, IMAGE_ID, expect.any(Number));
    const sent = bodies[0]!.scene;
    expect(previewabilityError(sent)).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain(IMAGE_BYTES.toString('base64'));
    expect(textOf(result)).toContain('does not exist or is not readable by this user');
    expect(textOf(result)).toContain(IMAGE_ID);
  });

  it('draws remote URLs and empty slots as placeholders instead of fetching them', async () => {
    const scene = slideScene([
      image('img-1', 'https://images.example.com/cat.png'),
      image('img-2', ''),
    ]);
    const readAsset = assetPool({});
    const { bodies, fetchPreview } = recordingRenderService();

    const result = await tool({ scene, readAsset, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);

    expect(readAsset).not.toHaveBeenCalled();
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    expect(previewabilityError(bodies[0]!.scene)).toBeUndefined();
    expect(textOf(result)).toContain('https://images.example.com/cat.png');
    expect(textOf(result)).toContain('it is empty');
  });

  it('keeps the request under the size budget, spending it on visual media first', async () => {
    const big = Buffer.alloc(Math.floor(PREVIEW_REQUEST_BUDGET_BYTES * 0.6), 1);
    const scene = slideScene([
      { type: 'audio', id: 'audio-1', src: 'ast_audio', left: 0, top: 0, width: 50, height: 50 },
      image('img-1', 'ast_image_a'),
      image('img-2', 'ast_image_b'),
    ]);
    const readAsset = assetPool({
      ast_audio: { owner: OWNER, bytes: big, mime: 'audio/mpeg' },
      ast_image_a: { owner: OWNER, bytes: big, mime: 'image/png' },
      ast_image_b: { owner: OWNER, bytes: IMAGE_BYTES, mime: 'image/png' },
    });
    const { bodies, fetchPreview } = recordingRenderService();

    const result = await tool({ scene, readAsset, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);

    const body = JSON.stringify(bodies[0]);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PREVIEW_REQUEST_BUDGET_BYTES);
    expect(previewabilityError(bodies[0]!.scene)).toBeUndefined();
    const elements = (
      bodies[0]!.scene as { content: { canvas: { elements: Array<{ src: string }> } } }
    ).content.canvas.elements;
    // The images fit and are inlined; the audio, read last, no longer fits.
    expect(elements[1]!.src).toMatch(/^data:image\/png;base64,/);
    expect(elements[2]!.src).toBe(`data:image/png;base64,${IMAGE_BYTES.toString('base64')}`);
    expect(elements[0]!.src).toMatch(/^data:image\/svg\+xml;/);
    expect(textOf(result)).toContain('preview request size limit');
    // The cap reaches the asset read, so oversized bytes are refused before
    // they are materialized.
    const firstCap = readAsset.mock.calls[0]![2];
    expect(firstCap).toBeGreaterThan(big.byteLength);
    expect(firstCap).toBeLessThanOrEqual((PREVIEW_REQUEST_BUDGET_BYTES * 3) / 4);
    expect(readAsset.mock.calls.at(-1)![2]).toBeLessThan(big.byteLength);
  });

  it('still refuses bytes over the budget when the asset read ignores its cap', async () => {
    const huge = Buffer.alloc(PREVIEW_REQUEST_BUDGET_BYTES, 1);
    const scene = slideScene([image('img-1', 'ast_huge')]);
    const readAsset = vi.fn(
      async (): Promise<PreviewAssetResolution> => ({
        status: 'resolved',
        buffer: huge,
        mimeType: 'image/png',
      }),
    );
    const { bodies, fetchPreview } = recordingRenderService();
    const result = await tool({ scene, readAsset, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(Buffer.byteLength(JSON.stringify(bodies[0]))).toBeLessThanOrEqual(
      PREVIEW_REQUEST_BUDGET_BYTES,
    );
    expect(previewabilityError(bodies[0]!.scene)).toBeUndefined();
    expect(textOf(result)).toContain('preview request size limit');
  });

  it("surfaces the render service's refusal reason", async () => {
    const scene = slideScene([image('img-1', 'data:image/png;base64,AAAA')]);
    const { fetchPreview } = recordingRenderService(() =>
      Response.json(
        { error: 'Scene is not self-contained: 2 slide media reference(s) must use data: URLs' },
        { status: 422 },
      ),
    );
    const result = await tool({ scene, fetchPreview }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toContain(
      'render service returned HTTP 422: Scene is not self-contained: 2 slide media reference(s) must use data: URLs',
    );

    const { fetchPreview: busy } = recordingRenderService(() =>
      Response.json({ error: 'Preview capacity is full', reason: 'preview_busy' }, { status: 429 }),
    );
    const busyResult = await tool({ scene, fetchPreview: busy }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(textOf(busyResult)).toContain(
      'render service returned HTTP 429: Preview capacity is full (preview_busy)',
    );

    const { fetchPreview: long } = recordingRenderService(
      () => new Response('x'.repeat(5_000), { status: 502 }),
    );
    const longResult = await tool({ scene, fetchPreview: long }).execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(textOf(longResult).length).toBeLessThan(700);
  });

  it('inlines the deployment-hosted interactive libraries from disk so the page passes the validator', async () => {
    const html = `<!doctype html><html><head>
<script src="${interactiveLibraryUrl('@tailwindcss/browser')}"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"></script>
</head><body><h1 class="text-2xl">Area</h1><p>The area is $\\pi r^2$.</p><canvas id="c"></canvas>
<script>new Chart(document.getElementById('c'), { type: 'bar', data: { labels: ['a'], datasets: [{ data: [1] }] } });</script>
</body></html>`;
    const scene = {
      id: 'scene-a',
      stageId: 'stage-a',
      order: 1,
      title: 'Interactive',
      type: 'interactive',
      content: { type: 'interactive', url: '', html },
      actions: [],
    };
    // As stored, the page loads hosted libraries the isolated preview cannot reach.
    expect(previewabilityError(scene as PreviewScene)).toMatch(
      /^Interactive HTML is not self-contained/,
    );

    const readLibraryFile = vi.fn(readHostedInteractiveLibraryFile);
    const { bodies, fetchPreview } = recordingRenderService();
    const [preview] = buildScenePreviewTools({
      store: storeOf(scene),
      stageAccess: async () => ({ kind: 'owned' as const }),
      ownerId: OWNER,
      renderService: { url: 'http://render.test' },
      fetchPreview,
      readLibraryFile,
    });
    const result = await preview!.execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);

    expect(result.content[0]).toMatchObject({ type: 'image' });
    const sent = bodies[0]!.scene as { content: { html: string } };
    expect(findNonSelfContainedInteractiveReferences(sent.content.html)).toEqual([]);
    expect(previewabilityError(bodies[0]!.scene)).toBeUndefined();
    const read = readLibraryFile.mock.calls.map(([directory, file]) => `${directory}/${file}`);
    expect(read).toEqual(
      expect.arrayContaining([
        '@tailwindcss/browser@4.1.18/dist/index.global.js',
        'chart.js@4.4.8/dist/chart.umd.js',
        'katex@0.16.38/dist/katex.min.css',
      ]),
    );
    expect(scene.content.html).toBe(html);
    expect(textOf(result)).toBe('');
  });

  it('reports interactive references that are not hosted libraries and never fetches them', async () => {
    const html =
      '<!doctype html><html><head><script src="https://cdn.example.com/widget.js"></script></head><body>x</body></html>';
    const scene = {
      id: 'scene-a',
      stageId: 'stage-a',
      order: 1,
      title: 'Interactive',
      type: 'interactive',
      content: { type: 'interactive', url: '', html },
      actions: [],
    };
    const readLibraryFile = vi.fn(readHostedInteractiveLibraryFile);
    const { fetchPreview } = recordingRenderService(() =>
      Response.json(
        {
          error:
            'Interactive HTML is not self-contained: 1 resource reference(s) must be inline or use data: URLs',
        },
        { status: 422 },
      ),
    );
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const [preview] = buildScenePreviewTools({
      store: storeOf(scene),
      stageAccess: async () => ({ kind: 'owned' as const }),
      ownerId: OWNER,
      renderService: { url: 'http://render.test' },
      fetchPreview,
      readLibraryFile,
    });
    const result = await preview!.execute('preview', {
      stageId: 'stage-a',
      sceneId: 'scene-a',
    } as never);
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
    expect(readLibraryFile).not.toHaveBeenCalled();
    expect(textOf(result)).toContain('HTTP 422: Interactive HTML is not self-contained');
    expect(textOf(result)).toContain('https://cdn.example.com/widget.js');
  });
});
