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

const docmind = vi.hoisted(() => ({
  calls: [] as string[],
  onCall: (_name: string): void => undefined,
  status: 'processing',
}));

vi.mock('@alicloud/docmind-api20220711', () => {
  class Request {
    constructor(readonly fields: unknown) {}
  }
  class Client {
    async submitDocParserJobAdvance() {
      docmind.calls.push('submit');
      docmind.onCall('submit');
      return { body: { data: { id: 'job-1' } } };
    }
    async queryDocParserStatus() {
      docmind.calls.push('status');
      docmind.onCall('status');
      return { body: { data: { status: docmind.status } } };
    }
    async getDocParserResult() {
      docmind.calls.push('result');
      docmind.onCall('result');
      // A full page: there may be another.
      return {
        body: {
          code: '200',
          data: { layouts: Array.from({ length: 100 }, (_, i) => ({ text: `l${i}` })) },
        },
      };
    }
  }
  return {
    default: Client,
    SubmitDocParserJobAdvanceRequest: Request,
    SubmitDocParserJobAdvanceRequestMultimediaParameters: Request,
    QueryDocParserStatusRequest: Request,
    GetDocParserResultRequest: Request,
  };
});

describe('AliDocMind cancellation', () => {
  const run = async (abortOn: string, status: string) => {
    const { parseWithAliDocMindClient } = await import('@/lib/pdf/alidocmind-client');
    docmind.calls = [];
    docmind.status = status;
    const controller = new AbortController();
    docmind.onCall = (name) => {
      if (name === abortOn) controller.abort(new Error('material deleted'));
    };
    await expect(
      parseWithAliDocMindClient(
        { accessKeyId: 'id', accessKeySecret: 'secret' },
        { buffer: Buffer.from('x'), fileName: 'a.pdf', signal: controller.signal },
      ),
    ).rejects.toThrow('material deleted');
    return docmind.calls;
  };

  it('makes no request after an abort during submission, polling or result pages', async () => {
    expect(await run('submit', 'processing')).toEqual(['submit']);
    expect(await run('status', 'processing')).toEqual(['submit', 'status']);
    expect(await run('result', 'success')).toEqual(['submit', 'status', 'result']);
  });
});

describe('local media command cancellation', () => {
  it('waits for a child that ignores SIGTERM to be killed before rejecting', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runMediaCommandProcess } = await import('@/lib/document/extractors/local-media');
    const dir = await mkdtemp(join(tmpdir(), 'openmaic-sigterm-'));
    const pidFile = join(dir, 'pid');
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const controller = new AbortController();
    const running = runMediaCommandProcess(
      process.execPath,
      ['-e', script],
      60_000,
      controller.signal,
      300,
    );
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
    });
    const abortedAt = Date.now();
    controller.abort(new Error('material deleted'));
    await expect(running).rejects.toThrow('material deleted');
    // Not before the grace ran out and SIGKILL ended it.
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(280);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
