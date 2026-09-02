import { describe, expect, it, vi } from 'vitest';
import {
  DownloadByteBudget,
  DownloadSizeLimitError,
  readResponseBodyWithLimit,
} from '@/lib/server/bounded-download';

describe('readResponseBodyWithLimit', () => {
  it('rejects an oversized Content-Length without reading the body', async () => {
    const getReader = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const response = {
      headers: new Headers({ 'content-length': '11' }),
      body: { getReader, cancel },
    } as unknown as Response;

    await expect(readResponseBodyWithLimit(response, { maxBytes: 10 })).rejects.toMatchObject({
      name: 'DownloadSizeLimitError',
      scope: 'response',
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a streaming overflow while another download in the batch succeeds', async () => {
    let oversizedReads = 0;
    const oversizedCancel = vi.fn();
    const oversizedBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          oversizedReads += 1;
          controller.enqueue(new Uint8Array([1, 2]));
          if (oversizedReads === 4) controller.close();
        },
        cancel: oversizedCancel,
      },
      { highWaterMark: 0 },
    );
    const smallBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([7, 8]));
        controller.close();
      },
    });
    const budget = new DownloadByteBudget(10);

    const results = await Promise.all([
      readResponseBodyWithLimit(new Response(oversizedBody), {
        maxBytes: 5,
        aggregateBudget: budget,
      }).catch((error: unknown) => error),
      readResponseBodyWithLimit(new Response(smallBody), {
        maxBytes: 5,
        aggregateBudget: budget,
      }),
    ]);

    expect(results[0]).toBeInstanceOf(DownloadSizeLimitError);
    expect(results[1]).toEqual(Buffer.from([7, 8]));
    expect(oversizedReads).toBe(3);
    expect(oversizedCancel).toHaveBeenCalledOnce();
  });

  it('enforces one aggregate budget across downloads', async () => {
    const budget = new DownloadByteBudget(3);
    await expect(
      readResponseBodyWithLimit(new Response(new Uint8Array([1, 2])), {
        maxBytes: 10,
        aggregateBudget: budget,
      }),
    ).resolves.toEqual(Buffer.from([1, 2]));

    await expect(
      readResponseBodyWithLimit(
        new Response(new Uint8Array([3, 4]), {
          headers: { 'content-length': '2' },
        }),
        { maxBytes: 10, aggregateBudget: budget },
      ),
    ).rejects.toMatchObject({ scope: 'aggregate' });
  });
});
