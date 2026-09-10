import { describe, expect, it, vi, beforeEach } from 'vitest';

import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';

const resolveServerAssetMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/persistence/resolve-server-asset', () => ({
  resolveServerAsset: resolveServerAssetMock,
}));

import { resolveVisionImagesForPrompt } from '@/lib/persistence/resolve-vision-images';

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = Buffer.from(BYTES).toString('base64');
const HEADERS = new Headers();

describe('resolveVisionImagesForPrompt (RFC #1153 part 2 B)', () => {
  beforeEach(() => {
    resolveServerAssetMock.mockReset();
  });

  it('resolves an allocated asset id to the SAME bytes the base64 path would send', async () => {
    resolveServerAssetMock.mockResolvedValue({
      status: 'resolved',
      buffer: Buffer.from(BYTES),
      mimeType: 'image/png',
    });

    const resolved = await resolveVisionImagesForPrompt(
      [{ id: 'img_1', src: 'ast_allocated_1', width: 640, height: 480 }],
      HEADERS,
    );

    // Fixture comparison: the browser-backed path sends the extraction bytes
    // as `data:image/png;base64,<base64>`; the server-backed path must
    // resolve the id to exactly that data URL so the vision prompt is
    // byte-identical — only the transport differs.
    expect(resolved).toEqual([
      { id: 'img_1', src: `data:image/png;base64,${BASE64}`, width: 640, height: 480 },
    ]);
    expect(resolveServerAssetMock).toHaveBeenCalledWith(
      'ast_allocated_1',
      HEADERS,
      MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES,
    );
  });

  it('passes data URLs and concrete URLs through untouched', async () => {
    const dataUrl = `data:image/png;base64,${BASE64}`;
    const resolved = await resolveVisionImagesForPrompt(
      [
        { id: 'img_1', src: dataUrl },
        { id: 'img_2', src: 'https://cdn.example.com/x.png' },
      ],
      HEADERS,
    );

    expect(resolved).toEqual([
      { id: 'img_1', src: dataUrl },
      { id: 'img_2', src: 'https://cdn.example.com/x.png' },
    ]);
    expect(resolveServerAssetMock).not.toHaveBeenCalled();
  });

  it('drops an id the server cannot resolve instead of leaking it to the LLM', async () => {
    resolveServerAssetMock.mockResolvedValue({ status: 'missing' });

    const resolved = await resolveVisionImagesForPrompt(
      [{ id: 'img_1', src: 'ast_gone' }],
      HEADERS,
    );
    expect(resolved).toEqual([]);
  });

  it('drops an OVERSIZED asset with the same warn-and-drop posture, passing the shared size cap (N5)', async () => {
    resolveServerAssetMock.mockResolvedValue({ status: 'too_large' });

    const resolved = await resolveVisionImagesForPrompt(
      [{ id: 'img_1', src: 'ast_huge' }],
      HEADERS,
    );
    expect(resolved).toEqual([]);
    // The cap rides the same resolve call: the store's `identify` rejects the
    // asset from its recorded length BEFORE any bytes are materialized.
    expect(resolveServerAssetMock).toHaveBeenCalledWith(
      'ast_huge',
      HEADERS,
      MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES,
    );
  });

  it('drops the image on a store failure (no raw error text reaches the caller)', async () => {
    resolveServerAssetMock.mockRejectedValue(new Error('database connection refused'));

    const resolved = await resolveVisionImagesForPrompt(
      [{ id: 'img_1', src: 'ast_boom' }],
      HEADERS,
    );
    expect(resolved).toEqual([]);
  });

  it('keeps the other images when only one fails to resolve', async () => {
    resolveServerAssetMock.mockImplementation(async (assetId: string) =>
      assetId === 'ast_ok'
        ? { status: 'resolved' as const, buffer: Buffer.from(BYTES), mimeType: 'image/png' }
        : { status: 'missing' as const },
    );

    const resolved = await resolveVisionImagesForPrompt(
      [
        { id: 'img_1', src: 'ast_ok' },
        { id: 'img_2', src: 'ast_missing' },
        { id: 'img_3', src: `data:image/png;base64,${BASE64}` },
      ],
      HEADERS,
    );

    expect(resolved.map((img) => img.id)).toEqual(['img_1', 'img_3']);
    expect(resolved[0]?.src).toBe(`data:image/png;base64,${BASE64}`);
  });
});
