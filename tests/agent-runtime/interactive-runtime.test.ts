import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inlineHtmlAssets } from '@/lib/export/inline-assets';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import type { Scene } from '@/lib/types/stage';
import {
  createInteractiveRuntimeClient,
  interactiveRuntimeFeedback,
} from '@/lib/server/agent-runtime/interactive-runtime';

vi.mock('@/lib/export/inline-assets', () => ({ inlineHtmlAssets: vi.fn() }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: vi.fn() }));

const html = '<script src="/vendor/interactive/chart.js@4.4.8/dist/chart.umd.js"></script>';
const stage = { id: 'stage', name: 'Course' };
const scene: Extract<Scene, { type: 'interactive' }> = {
  id: 'scene',
  stageId: stage.id,
  order: 1,
  type: 'interactive',
  title: 'Scene',
  content: { type: 'interactive', html },
  actions: [{ id: 'reveal', type: 'widget_reveal', target: '#part' }],
};

beforeEach(() => {
  vi.stubEnv('RENDER_SERVICE_URL', 'https://render.example');
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe('interactive runtime client', () => {
  it('posts the original scene and signal without inlining its HTML', async () => {
    const signal = new AbortController().signal;
    vi.mocked(proxyFetch).mockResolvedValueOnce(Response.json({ errors: [] }));

    await expect(createInteractiveRuntimeClient('owner')!(scene, stage, signal)).resolves.toEqual(
      [],
    );

    expect(inlineHtmlAssets).not.toHaveBeenCalled();
    expect(proxyFetch).toHaveBeenCalledExactlyOnceWith(
      'https://render.example/interactive-runtime-check',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openmaic-client': 'owner' },
        body: JSON.stringify({
          version: 1,
          scene,
          stage,
          viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        }),
        signal,
      },
    );
  });

  it('skips the POST if the caller already aborted', async () => {
    const error = new Error('Cancelled');
    await expect(
      createInteractiveRuntimeClient('owner')!(scene, stage, AbortSignal.abort(error)),
    ).rejects.toBe(error);
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('keeps the six-second deadline and cancels an active check with the caller', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      vi.mocked(proxyFetch).mockImplementationOnce(() => new Promise(() => {}));
      const caller = new AbortController();
      const feedback = interactiveRuntimeFeedback(
        createInteractiveRuntimeClient('owner'),
        scene,
        stage,
        caller.signal,
      );
      expect(timeout).toHaveBeenCalledWith(6_000);
      const requestSignal = vi.mocked(proxyFetch).mock.calls[0]?.[1]?.signal;
      expect(requestSignal?.aborted).toBe(false);
      caller.abort();
      expect(requestSignal?.aborted).toBe(true);
      await expect(feedback).resolves.toBe('\nInteractive page runtime was not checked.');
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([429, 500])('keeps HTTP %i feedback best-effort', async (status) => {
    vi.mocked(proxyFetch).mockResolvedValueOnce(new Response(null, { status }));
    await expect(
      interactiveRuntimeFeedback(createInteractiveRuntimeClient('owner'), scene, stage),
    ).resolves.toBe('\nInteractive page runtime was not checked.');
  });
});
