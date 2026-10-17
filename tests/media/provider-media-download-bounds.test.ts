import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_PROVIDER_MEDIA_BYTES, readResponseBodyWithLimit } from '@/lib/media/bounded-download';
import { generateWithComfyuiImage } from '@/lib/media/adapters/comfyui-image-adapter';
import { generateWithOpenRouterVideo } from '@/lib/media/adapters/openrouter-video-adapter';
import { generateWithVeo } from '@/lib/media/adapters/veo-adapter';

/** A response whose body streams `chunkCount` chunks of `chunkSize` bytes. */
function streamedResponse(chunkCount: number, chunkSize: number, contentType = 'video/mp4') {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

/** Tracks whether the body was cancelled, so a refused download must not hold the stream. */
function cancellableStreamedResponse(chunkCount: number, chunkSize: number) {
  let cancelled = false;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunkCount) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'video/mp4' },
  });
  return { response, wasCancelled: () => cancelled };
}

describe('readResponseBodyWithLimit', () => {
  it('returns the bytes of a response within the limit', async () => {
    const { response } = cancellableStreamedResponse(3, 4);

    const bytes = await readResponseBodyWithLimit(response, { maxBytes: 100 });

    expect(bytes.byteLength).toBe(12);
  });

  it('rejects a declared content-length over the limit before reading a byte', async () => {
    // A null body plus an over-limit declared length: the fast reject must fire
    // on the header alone, with no body to buffer.
    const response = new Response(null, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '101' },
    });
    expect(response.body).toBeNull();

    await expect(
      readResponseBodyWithLimit(response, { maxBytes: 100, label: 'clip download' }),
    ).rejects.toThrow('clip download: Download exceeded the 100-byte response limit');
  });

  it('keeps the unlabeled message shape for existing server callers', async () => {
    const response = new Response(null, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '101' },
    });

    await expect(readResponseBodyWithLimit(response, { maxBytes: 100 })).rejects.toThrow(
      'Download exceeded the 100-byte response limit',
    );
  });

  it('cuts off a body that streams past the limit and cancels the stream', async () => {
    const { response, wasCancelled } = cancellableStreamedResponse(50, 10);

    await expect(
      readResponseBodyWithLimit(response, { maxBytes: 100, label: 'clip download' }),
    ).rejects.toThrow('clip download: Download exceeded the 100-byte response limit');
    expect(wasCancelled()).toBe(true);
  });

  it('rejects a body with no content-length that grows past the limit', async () => {
    const response = streamedResponse(20, 10);
    expect(response.headers.get('content-length')).toBeNull();

    await expect(readResponseBodyWithLimit(response, { maxBytes: 64 })).rejects.toThrow(
      'Download exceeded the 64-byte response limit',
    );
  });

  it('caps provider media at the generated-video budget, not lower', () => {
    // A clip the persist path accepts (MAX_GENERATED_VIDEO_BYTES) must not be
    // refused one step earlier at the adapter download.
    expect(MAX_PROVIDER_MEDIA_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('the media adapters refuse an oversized provider download', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A download response declaring one byte over the shared ceiling. */
  function oversizedDownload(): Response {
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(MAX_PROVIDER_MEDIA_BYTES + 1),
      },
    });
  }

  it('Veo: a download declaring more than the ceiling is refused', async () => {
    // Same-origin file URL, so no redirect handling is involved. Dispatch on
    // the download URL itself: whatever the adapter asks its API before the
    // download, the JSON shape it gets back leads to this file URI.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/files/clip')) {
        return oversizedDownload();
      }
      return new Response(
        JSON.stringify({
          name: 'operations/veo-bounded',
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: 'https://veo.example/files/clip' } }],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateWithVeo(
        {
          providerId: 'veo',
          apiKey: 'k',
          baseUrl: 'https://veo.example',
          model: 'veo-3.0-generate-001',
        },
        { prompt: 'a paper city', aspectRatio: '16:9', duration: 8 },
      ),
    ).rejects.toThrow('Veo video download: Download exceeded the');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('OpenRouter: a content download over the ceiling is refused', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/videos/job-b/content?index=0')) {
        return oversizedDownload();
      }
      if (url.endsWith('/videos')) {
        return new Response(JSON.stringify({ id: 'job-b', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'job-b', status: 'completed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = generateWithOpenRouterVideo(
      { providerId: 'openrouter-video', apiKey: 'k', model: 'google/veo-3.1' },
      { prompt: 'a fox running', aspectRatio: '16:9', duration: 5 },
    );
    // Attach the rejection handler before advancing: the download refusal
    // fires during the timer run, and a late handler reads as unhandled.
    const rejection = expect(promise).rejects.toThrow(
      'OpenRouter video download: Download exceeded the',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });

  it('ComfyUI: a /view download over the ceiling is refused', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/view?')) {
        return oversizedDownload();
      }
      if (url.endsWith('/prompt')) {
        return new Response(JSON.stringify({ prompt_id: 'p1', node_errors: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          // /history/{id} answers keyed by the prompt id.
          p1: {
            outputs: {
              node9: { images: [{ filename: 'img.png', subfolder: '', type: 'output' }] },
            },
            status: { status_str: 'success', completed: true },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = generateWithComfyuiImage(
      {
        providerId: 'comfyui-image',
        apiKey: '',
        model: 'comfyui-workflow.json',
        // The workflowJson fast path skips the file-system workflow load.
        // Titles live under _meta.title (ComfyUI's API-format workflow).
        workflowJson: {
          '1': {
            _meta: { title: 'Input Prompt' },
            inputs: { text: '' },
          },
        },
      } as Parameters<typeof generateWithComfyuiImage>[0],
      { prompt: 'a paper city' },
    );
    const rejection = expect(promise).rejects.toThrow(
      'ComfyUI image "img.png": Download exceeded the',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });
});
