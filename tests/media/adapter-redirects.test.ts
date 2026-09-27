import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateWithComfyuiImage } from '@/lib/media/adapters/comfyui-image-adapter';
import { generateWithGrokImage } from '@/lib/media/adapters/grok-image-adapter';
import { generateWithGrokVideo } from '@/lib/media/adapters/grok-video-adapter';
import { generateWithHappyHorse } from '@/lib/media/adapters/happyhorse-adapter';
import { generateWithKling } from '@/lib/media/adapters/kling-adapter';
import { generateWithLemonadeImage } from '@/lib/media/adapters/lemonade-image-adapter';
import { generateWithMiniMaxImage } from '@/lib/media/adapters/minimax-image-adapter';
import { generateWithMiniMaxVideo } from '@/lib/media/adapters/minimax-video-adapter';
import { generateWithNanoBanana } from '@/lib/media/adapters/nano-banana-adapter';
import { generateWithOpenAIImage } from '@/lib/media/adapters/openai-image-adapter';
import { generateWithQwenImage } from '@/lib/media/adapters/qwen-image-adapter';
import { generateWithSeedance } from '@/lib/media/adapters/seedance-adapter';
import { generateWithSeedream } from '@/lib/media/adapters/seedream-adapter';
import { generateWithVeo } from '@/lib/media/adapters/veo-adapter';
import type { ImageGenerationConfig, VideoGenerationConfig } from '@/lib/media/types';

/**
 * Every provider call the media adapters make must refuse a redirect. The
 * request carries the provider credential, and the base URL comes from provider
 * settings a caller can supply, so following a 3xx would replay that credential
 * at a host the caller chose. #930 applied this to the connectivity probes; the
 * generation and poll calls in the same files were left following redirects.
 */
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
// ComfyUI loads its workflow through `window.location.origin` before it talks to
// the provider, so the same-origin load needs an origin to resolve.
vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } });

const BASE_URL = 'https://provider.example.com';
const REDIRECT_LOCATION = 'http://127.0.0.1/internal';

const imageConfig = (providerId: ImageGenerationConfig['providerId']): ImageGenerationConfig => ({
  providerId,
  apiKey: 'test-key',
  baseUrl: BASE_URL,
  model: 'test-model',
});

const videoConfig = (providerId: VideoGenerationConfig['providerId']): VideoGenerationConfig => ({
  providerId,
  apiKey: 'test-key',
  baseUrl: BASE_URL,
  model: 'test-model',
});

const imageOptions = { prompt: 'a test prompt', width: 1024, height: 1024 };
const videoOptions = { prompt: 'a test prompt' };

function redirectResponse(): Response {
  return new Response(null, { status: 302, headers: { location: REDIRECT_LOCATION } });
}

interface RedirectCase {
  name: string;
  /** Extra setup, e.g. a response queued ahead of the redirect. */
  prepare?: () => void;
  run: () => Promise<unknown>;
}

const cases: RedirectCase[] = [
  {
    name: 'Seedream image generation',
    run: () => generateWithSeedream(imageConfig('seedream'), imageOptions),
  },
  {
    name: 'OpenAI image generation',
    run: () => generateWithOpenAIImage(imageConfig('openai-image'), imageOptions),
  },
  {
    name: 'Qwen image generation',
    run: () => generateWithQwenImage(imageConfig('qwen-image'), imageOptions),
  },
  {
    name: 'Grok image generation',
    run: () => generateWithGrokImage(imageConfig('grok-image'), imageOptions),
  },
  {
    name: 'Lemonade image generation',
    run: () => generateWithLemonadeImage(imageConfig('lemonade'), imageOptions),
  },
  {
    name: 'MiniMax image generation',
    run: () => generateWithMiniMaxImage(imageConfig('minimax-image'), imageOptions),
  },
  {
    name: 'Nano Banana image generation',
    run: () => generateWithNanoBanana(imageConfig('nano-banana'), imageOptions),
  },
  {
    name: 'ComfyUI workflow submission',
    // The first request is the same-origin workflow load, which is not a
    // provider call and is expected to succeed. It serves the repo's own
    // workflow, since the adapter validates both its filename and its structure.
    prepare: () => {
      const workflow = readFileSync(
        resolve(__dirname, '../../public/comfyui-workflow.json'),
        'utf8',
      );
      fetchMock.mockResolvedValueOnce(new Response(workflow, { status: 200 }));
    },
    run: () =>
      generateWithComfyuiImage(
        { ...imageConfig('comfyui-image'), model: 'comfyui-workflow.json' },
        imageOptions,
      ),
  },
  {
    name: 'Seedance video submission',
    run: () => generateWithSeedance(videoConfig('seedance'), videoOptions),
  },
  {
    name: 'Kling video submission',
    // Kling builds a JWT from an "accessKey:secretKey" pair.
    run: () =>
      generateWithKling({ ...videoConfig('kling'), apiKey: 'access-key:secret-key' }, videoOptions),
  },
  {
    name: 'Grok video submission',
    run: () => generateWithGrokVideo(videoConfig('grok-video'), videoOptions),
  },
  {
    name: 'HappyHorse video submission',
    run: () => generateWithHappyHorse(videoConfig('happyhorse'), videoOptions),
  },
  {
    name: 'MiniMax video submission',
    run: () => generateWithMiniMaxVideo(videoConfig('minimax-video'), videoOptions),
  },
  {
    name: 'Veo video submission',
    run: () => generateWithVeo(videoConfig('veo'), videoOptions),
  },
];

describe('media adapter provider calls refuse redirects', () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  it.each(cases)('$name', async ({ prepare, run }) => {
    fetchMock.mockResolvedValue(redirectResponse());
    prepare?.();

    await expect(run()).rejects.toThrow(/Redirects are not allowed/);

    // Every request that carried an init object — i.e. every provider call, as
    // opposed to ComfyUI's init-less same-origin workflow load — must have asked
    // fetch not to follow redirects.
    const providerCalls = fetchMock.mock.calls.filter(([, init]) => init !== undefined);
    expect(providerCalls.length).toBeGreaterThan(0);
    for (const [, init] of providerCalls) {
      expect(init.redirect).toBe('manual');
    }
  });
});
