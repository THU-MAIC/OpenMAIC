import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ImageMapping, PdfImage } from '@/lib/types/generation';

const streamLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());
const resolveVisionImagesMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: streamLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

vi.mock('@/lib/persistence/resolve-vision-images', () => ({
  resolveVisionImagesForPrompt: resolveVisionImagesMock,
}));

/**
 * The standard (non-task-engine) outline branch must rebuild its placeholder
 * text from the SAME RESOLVED set the route attaches (RFC #1153 part 2, N3):
 * the task-engine/interactive branch already builds its text from
 * `resolvedVisionImages`, but the standard `buildOutlinePrompt` branch
 * rebuilds its own `[see attached]` placeholders from the unresolved slice —
 * so an id the server cannot resolve used to leave a dangling promise in the
 * standard prompt. This test pins the fixed branch: a dropped image drops its
 * text mention AND its attachment.
 */
describe('scene-outlines-stream route — standard branch prompt parity on a dropped image (N3)', () => {
  beforeEach(() => {
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveVisionImagesMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: { vision: true } },
      modelString: 'test:test-model',
      thinkingConfig: undefined,
    });
  });

  test('drops an unresolvable image from the standard prompt text and the attachments', async () => {
    vi.resetModules();
    const dataUrlFor = (bytes: string) =>
      `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
    // The pre-resolution drops img_2 (its id does not resolve server-side);
    // img_1 resolves to bytes.
    resolveVisionImagesMock.mockImplementation(async (images: Array<{ id: string; src: string }>) =>
      images
        .filter((image) => image.src !== 'ast_gone')
        .map((image) => ({ ...image, src: dataUrlFor(`outline-bytes-${image.id}`) })),
    );
    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield JSON.stringify({
          languageDirective: 'Teach in English.',
          outlines: [
            {
              id: 'scene_1',
              type: 'slide',
              title: 'Safety Checklist',
              description: 'Inspect the device.',
              keyPoints: ['Inspect', 'Calibrate'],
              order: 1,
            },
          ],
        });
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        pdfImages: [
          { id: 'img_1', src: '', pageNumber: 1, width: 100, height: 100 },
          { id: 'img_2', src: '', pageNumber: 2, width: 200, height: 100 },
        ],
        imageMapping: { img_1: 'ast_ok', img_2: 'ast_gone' },
      }),
    );
    await readStreamBody(response);

    // The standard branch ran with a vision-enabled model, so the LLM call is
    // multimodal and its text half is the standard prompt's user text.
    const streamParams = streamLLMMock.mock.calls[0][0] as {
      system: string;
      messages: Array<{
        role: string;
        content: Array<{ type: string; text?: string; image?: string }>;
      }>;
    };
    expect(streamParams.messages).toBeDefined();
    const content = streamParams.messages[0].content;
    const textPart = content.find((part) => part.type === 'text');
    // img_1 is promised `[see attached]` and IS attached; img_2's text
    // mention is gone together with its attachment.
    expect(textPart?.text).toContain('img_1');
    expect(textPart?.text).toContain('[see attached]');
    expect(textPart?.text).not.toContain('img_2');
    const imageParts = content.filter((part) => part.type === 'image');
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]?.image).toBe(Buffer.from('outline-bytes-img_1').toString('base64'));
  });
});

function readStreamBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pump = (): Promise<void> =>
    reader!.read().then(({ done, value }) => {
      if (done) return;
      if (value) text += decoder.decode(value, { stream: true });
      return pump();
    });
  return pump().then(() => text);
}

function mockRequest(body: {
  pdfImages: Array<Pick<PdfImage, 'id' | 'src' | 'pageNumber' | 'width' | 'height'>>;
  imageMapping: ImageMapping;
}) {
  return {
    json: async () => ({
      requirements: { requirement: 'Teach a safety checklist course.' },
      pdfText: 'Inspect the device before calibration.',
      pdfImages: body.pdfImages,
      imageMapping: body.imageMapping,
      researchContext: '',
    }),
    headers: {
      get: () => null,
    },
  } as unknown as Parameters<
    typeof import('@/app/api/generate/scene-outlines-stream/route').POST
  >[0];
}
