/**
 * Extractors stop when their caller does: the signal in the extractor config
 * aborts self-hosted MinerU's request, MinerU Cloud's requests (no retry of an
 * abort) and the local media pipeline's commands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetches = vi.hoisted(() => ({ calls: [] as Array<{ url: string; signal?: AbortSignal }> }));

vi.mock('@/lib/server/provider-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-fetch')>()),
  providerFetch: (url: string, init: RequestInit = {}) => {
    fetches.calls.push({ url, signal: init.signal ?? undefined });
    // Answers only by failing once the request is aborted.
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  },
}));

import { createLocalMediaExtractorProvider } from '@/lib/document/extractors/local-media';
import { parseWithMinerUCloud } from '@/lib/pdf/mineru-cloud';
import { parseWithMinerUDocument } from '@/lib/pdf/pdf-providers';

beforeEach(() => {
  fetches.calls = [];
});

describe('extractor cancellation', () => {
  it('aborts the self-hosted MinerU request', async () => {
    const controller = new AbortController();
    const parsing = parseWithMinerUDocument(
      {
        providerId: 'mineru',
        baseUrl: 'http://mineru.local:8000',
        managed: true,
        signal: controller.signal,
      },
      Buffer.from('%PDF-1.4'),
      { fileName: 'a.pdf', mimeType: 'application/pdf' },
    );
    await vi.waitFor(() => expect(fetches.calls).toHaveLength(1));
    controller.abort(new Error('material deleted'));
    await expect(parsing).rejects.toThrow();
    expect(fetches.calls[0]!.signal?.aborted).toBe(true);
  });

  it('aborts MinerU Cloud without retrying the aborted request', async () => {
    const controller = new AbortController();
    const parsing = parseWithMinerUCloud(
      { providerId: 'mineru-cloud', apiKey: 'k', managed: true, signal: controller.signal },
      Buffer.from('%PDF-1.4'),
      'a.pdf',
    );
    await vi.waitFor(() => expect(fetches.calls).toHaveLength(1));
    controller.abort(new Error('material deleted'));
    await expect(parsing).rejects.toThrow('material deleted');
    expect(fetches.calls).toHaveLength(1);
    expect(fetches.calls[0]!.signal?.aborted).toBe(true);
  });

  it('kills the local media command in flight', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const commands = {
      resolve: vi.fn(async () => '/usr/bin/tool'),
      run: vi.fn(
        (_file: string, _args: string[], _timeoutMs: number, signal?: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            seen.push(signal);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const local = createLocalMediaExtractorProvider({ commands });
    const extracting = local.extract({
      buffer: Buffer.from('fake'),
      fileName: 'talk.mp3',
      mimeType: 'audio/mpeg',
      config: { providerId: 'local-ffmpeg', signal: controller.signal },
    });
    await vi.waitFor(() => expect(commands.run).toHaveBeenCalledTimes(1));
    controller.abort(new Error('material deleted'));
    await expect(extracting).rejects.toThrow('material deleted');
    expect(seen[0]).toBe(controller.signal);
  });
});
