import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  comfyuiGenerationTimeoutMs,
  generateWithComfyuiImage,
} from '@/lib/media/adapters/comfyui-image-adapter';
import type { ImageGenerationConfig } from '@/lib/media/types';

const fetchMock = vi.fn();

function sdxlWorkflow(): Record<string, unknown> {
  return {
    '2': {
      inputs: { value: '' },
      class_type: 'PrimitiveStringMultiline',
      _meta: { title: 'Input Prompt' },
    },
    '5': {
      inputs: { width: 1024, height: 1024, batch_size: 1 },
      class_type: 'EmptyLatentImage',
      _meta: { title: 'Empty Latent Image' },
    },
    '6': {
      inputs: {
        seed: 1,
        steps: 20,
        cfg: 7,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
      },
      class_type: 'KSampler',
      _meta: { title: 'KSampler' },
    },
  };
}

function completedHistory(promptId: string) {
  return {
    [promptId]: {
      outputs: {
        '8': { images: [{ filename: 'openmaic.png', subfolder: '', type: 'output' }] },
      },
      status: { status_str: 'success', completed: true },
    },
  };
}

describe('ComfyUI SDXL sizing and timeout', () => {
  const originalTimeout = process.env.COMFYUI_GENERATION_TIMEOUT_MS;

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalTimeout === undefined) delete process.env.COMFYUI_GENERATION_TIMEOUT_MS;
    else process.env.COMFYUI_GENERATION_TIMEOUT_MS = originalTimeout;
  });

  it('reads COMFYUI_GENERATION_TIMEOUT_MS and ignores values under 60 seconds', () => {
    delete process.env.COMFYUI_GENERATION_TIMEOUT_MS;
    expect(comfyuiGenerationTimeoutMs()).toBe(720_000);
    process.env.COMFYUI_GENERATION_TIMEOUT_MS = '90000';
    expect(comfyuiGenerationTimeoutMs()).toBe(90_000);
    process.env.COMFYUI_GENERATION_TIMEOUT_MS = '1000';
    expect(comfyuiGenerationTimeoutMs()).toBe(720_000);
  });

  it('patches explicit width and height instead of expanding aspectRatio to 1920x1080', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    let queued: { prompt?: Record<string, { inputs?: Record<string, unknown> }> } | undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/prompt')) {
        queued = JSON.parse(String(init?.body)) as typeof queued;
        return new Response(JSON.stringify({ prompt_id: 'p1', number: 1, node_errors: {} }), {
          status: 200,
        });
      }
      if (href.includes('/history/')) {
        return new Response(JSON.stringify(completedHistory('p1')), { status: 200 });
      }
      if (href.includes('/view')) {
        return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    const config = {
      providerId: 'comfyui-image',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8188',
      workflowJson: sdxlWorkflow(),
    } as ImageGenerationConfig;
    const pending = generateWithComfyuiImage(config, {
      prompt: 'a classroom diagram',
      width: 1344,
      height: 768,
      aspectRatio: '16:9',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(queued?.prompt?.['5']?.inputs).toMatchObject({ width: 1344, height: 768 });
    expect(queued?.prompt?.['2']?.inputs?.value).toBe('a classroom diagram');
    expect(result).toMatchObject({ width: 1344, height: 768 });
  });

  it('falls back to aspectRatio expansion when no pixel size is given', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    let queued: { prompt?: Record<string, { inputs?: Record<string, unknown> }> } | undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/prompt')) {
        queued = JSON.parse(String(init?.body)) as typeof queued;
        return new Response(JSON.stringify({ prompt_id: 'p2', number: 1, node_errors: {} }), {
          status: 200,
        });
      }
      if (href.includes('/history/')) {
        return new Response(JSON.stringify(completedHistory('p2')), { status: 200 });
      }
      if (href.includes('/view')) {
        return new Response(Uint8Array.from([1]), { status: 200 });
      }
      throw new Error(`unexpected fetch ${href}`);
    });

    const config = {
      providerId: 'comfyui-image',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8188',
      workflowJson: sdxlWorkflow(),
    } as ImageGenerationConfig;
    const pending = generateWithComfyuiImage(config, {
      prompt: 'portrait',
      aspectRatio: '9:16',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    // maxResolution is 1920×1920, so 9:16 pins width to 1920 and then the
    // height clamp brings it back inside the box: 1080×1920.
    expect(queued?.prompt?.['5']?.inputs).toMatchObject({ width: 1080, height: 1920 });
  });
});
