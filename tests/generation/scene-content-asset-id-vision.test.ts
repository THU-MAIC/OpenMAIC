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

function slideOutline(): SceneOutline {
  return {
    id: 'scene-slide',
    type: 'slide',
    title: 'Safety Checklist',
    description: 'Inspect the device before calibration.',
    keyPoints: ['Inspect', 'Calibrate'],
    order: 1,
    suggestedImageIds: ['img_1'],
  };
}
