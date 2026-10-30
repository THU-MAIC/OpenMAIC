import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveModel, callLLM } = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
}));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel }));
vi.mock('@/lib/ai/llm', () => ({ callLLM }));
vi.mock('@/lib/server/model-config/runtime', () => ({
  backgroundWorkspaceId: vi.fn(async () => 'workspace-1'),
}));

import {
  createGenerationAiCallFactory,
  resolveVisionImages,
  type VisionAssetReader,
} from '@/lib/server/agent-runtime/generation-ai-call';

async function png(width = 4, height = 3): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#cc3300' } })
    .png()
    .toBuffer();
}

function resolvedReader(bytes: Buffer, mimeType = 'image/png'): VisionAssetReader {
  return vi.fn(async () => ({ status: 'resolved' as const, buffer: bytes, mimeType }));
}

describe('resolveVisionImages', () => {
  it('passes data and HTTP(S) URLs through without reading the asset pool', async () => {
    const dataUrl = `data:image/png;base64,${(await png()).toString('base64')}`;
    const readAsset = vi.fn<VisionAssetReader>();
    const images = await resolveVisionImages(
      [
        { id: 'img_1', src: dataUrl },
        { id: 'img_2', src: 'https://example.com/figure.png' },
      ],
      'owner-1',
      readAsset,
    );
    expect(images).toEqual([
      { id: 'img_1', src: dataUrl },
      { id: 'img_2', src: 'https://example.com/figure.png' },
    ]);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("resolves an allocated asset id from the owner's partition into an inline image", async () => {
    const bytes = await png();
    const readAsset = resolvedReader(bytes);
    const images = await resolveVisionImages(
      [{ id: 'img_1', src: 'ast_figure1', width: 4, height: 3 }],
      'owner-1',
      readAsset,
    );
    expect(readAsset).toHaveBeenCalledWith('owner-1', 'ast_figure1', expect.any(Number));
    expect(images).toEqual([
      {
        id: 'img_1',
        src: `data:image/png;base64,${bytes.toString('base64')}`,
        width: 4,
        height: 3,
      },
    ]);
  });

  it('drops a missing, oversized or unreadable asset and keeps the rest in order', async () => {
    const bytes = await png();
    const readAsset: VisionAssetReader = vi.fn(async (_owner, assetId) => {
      if (assetId === 'ast_missing') return { status: 'missing' as const };
      if (assetId === 'ast_too_large') return { status: 'too_large' as const };
      if (assetId === 'ast_broken') throw new Error('store down');
      return { status: 'resolved' as const, buffer: bytes, mimeType: 'image/png' };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const images = await resolveVisionImages(
      [
        { id: 'img_1', src: 'ast_missing' },
        { id: 'img_2', src: 'ast_ok' },
        { id: 'img_3', src: 'ast_too_large' },
        { id: 'img_4', src: 'ast_broken' },
      ],
      'owner-1',
      readAsset,
    );
    warn.mockRestore();
    expect(images.map((image) => image.id)).toEqual(['img_2']);
  });

  it('drops allocated asset ids when the run has no owner', async () => {
    const readAsset = vi.fn<VisionAssetReader>();
    const images = await resolveVisionImages(
      [
        { id: 'img_1', src: 'ast_figure1' },
        { id: 'img_2', src: 'https://example.com/figure.png' },
      ],
      undefined,
      readAsset,
    );
    expect(images.map((image) => image.id)).toEqual(['img_2']);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it('downscales an image larger than the vision bound', async () => {
    const readAsset = resolvedReader(await png(3000, 20));
    const [image] = await resolveVisionImages(
      [{ id: 'img_1', src: 'ast_wide', width: 3000, height: 20 }],
      'owner-1',
      readAsset,
    );
    expect(image.src.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(image.width).toBeLessThanOrEqual(2048);
  });
});

describe('createGenerationAiCallFactory', () => {
  beforeEach(() => {
    resolveModel.mockReset();
    callLLM.mockReset();
    callLLM.mockResolvedValue({ text: 'generated' });
  });

  function routeTo(vision: boolean) {
    resolveModel.mockResolvedValue({
      model: { id: 'routed-model' },
      modelInfo: { capabilities: { vision }, outputWindow: 4096 },
      thinkingConfig: undefined,
      serverManaged: false,
    });
  }

  it('sends page images as image parts when the routed model accepts images', async () => {
    routeTo(true);
    const readAsset = resolvedReader(await png());
    const routed = createGenerationAiCallFactory({ ownerId: 'owner-1', readAsset });
    await expect(routed.supportsVision('scene-content:slide')).resolves.toBe(true);

    const text = await routed('scene-content:slide')('system', 'user prompt', [
      { id: 'img_1', src: 'ast_figure1' },
    ]);

    expect(text).toBe('generated');
    const [request] = callLLM.mock.calls[0];
    expect(request.prompt).toBeUndefined();
    const content = request.messages[0].content as Array<{ type: string }>;
    expect(content[0]).toEqual({ type: 'text', text: 'user prompt' });
    expect(content.some((part) => part.type === 'image')).toBe(true);
    // The model is resolved once per stage, for both the probe and the call.
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });

  it('stays text-only when the routed model does not accept images', async () => {
    routeTo(false);
    const readAsset = vi.fn<VisionAssetReader>();
    const routed = createGenerationAiCallFactory({ ownerId: 'owner-1', readAsset });
    await expect(routed.supportsVision('scene-content:slide')).resolves.toBe(false);

    await routed('scene-content:slide')('system', 'user prompt', [
      { id: 'img_1', src: 'ast_figure1' },
    ]);

    const [request] = callLLM.mock.calls[0];
    expect(request.prompt).toBe('user prompt');
    expect(request.messages).toBeUndefined();
    expect(readAsset).not.toHaveBeenCalled();
  });

  it('falls back to text when no image resolves', async () => {
    routeTo(true);
    const readAsset: VisionAssetReader = vi.fn(async () => ({ status: 'missing' as const }));
    const routed = createGenerationAiCallFactory({ ownerId: 'owner-1', readAsset });

    await routed('scene-content:slide')('system', 'user prompt', [
      { id: 'img_1', src: 'ast_gone' },
    ]);

    const [request] = callLLM.mock.calls[0];
    expect(request.prompt).toBe('user prompt');
    expect(request.messages).toBeUndefined();
  });
});
