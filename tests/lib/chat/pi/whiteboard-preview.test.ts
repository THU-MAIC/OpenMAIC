import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoldedWhiteboardRuntimeState } from '@/lib/whiteboard/runtime/types';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), asset: vi.fn() }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.fetch }));
vi.mock('@/lib/persistence/resolve-server-asset', () => ({ resolveOwnedAsset: mocks.asset }));
import { createWhiteboardPreview } from '@/lib/chat/pi/whiteboard-preview';
import { withAgentToolTimeout } from '@/lib/agent/runtime/tool-timeout';
import { Type } from 'typebox';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
  'base64',
);
const empty: FoldedWhiteboardRuntimeState = { sessionId: null, lastSeq: null, whiteboard: null };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('optional whiteboard scene preview client', () => {
  it('does no work without the existing render service configuration', () => {
    vi.stubEnv('RENDER_SERVICE_URL', '');
    expect(createWhiteboardPreview('owner', 'stage')).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('renders the whole empty board through the public scene protocol', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render.test/');
    mocks.fetch.mockResolvedValue(new Response(png));
    const result = await createWhiteboardPreview('owner', 'stage')!(empty);
    expect(result).toMatchObject({
      image: { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
      bytes: png.length,
    });
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe('http://render.test/preview');
    expect(options.headers['x-openmaic-client']).toBe('owner');
    expect(JSON.parse(options.body)).toMatchObject({
      version: 1,
      stage: { id: 'stage' },
      scene: {
        content: {
          canvas: {
            elements: [],
            viewportSize: 1000,
            viewportRatio: 0.5625,
            background: { type: 'solid', color: '#ffffff' },
          },
        },
      },
      viewport: { width: 1000, height: 563, deviceScaleFactor: 1 },
    });
  });

  it.each([503, 200])('rejects unavailable or non-PNG preview responses (%s)', async (status) => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render.test');
    mocks.fetch.mockResolvedValue(new Response('not a PNG', { status }));
    await expect(createWhiteboardPreview('owner', 'stage')!(empty)).rejects.toThrow(
      status === 503 ? 'Preview HTTP 503' : 'Preview did not return a PNG',
    );
  });

  it('does not start rendering after cancellation or with insufficient tool budget', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render.test');
    const preview = createWhiteboardPreview('owner', 'stage')!;
    const controller = new AbortController();
    controller.abort();
    await expect(preview(empty, controller.signal)).rejects.toThrow();
    const tool = withAgentToolTimeout(
      {
        name: 'preview-test',
        label: 'Preview',
        description: '',
        parameters: Type.Object({}),
        execute: async (_id, _args, signal) => {
          await expect(preview(empty, signal)).rejects.toThrow('Insufficient preview budget');
          return { content: [], details: {} };
        },
      },
      200,
    );
    await tool.execute('call', {}, undefined);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
