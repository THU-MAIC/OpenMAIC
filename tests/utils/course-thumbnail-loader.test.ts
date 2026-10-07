import { describe, expect, it, vi } from 'vitest';
import type { Slide } from '@openmaic/dsl';
import { CourseThumbnailLoader } from '@/lib/utils/course-thumbnail-loader';

function slide(id: string): Slide {
  return { id, viewportSize: 1000, viewportRatio: 0.5625, elements: [] } as unknown as Slide;
}

interface Pending {
  readonly stageId: string;
  readonly signal: AbortSignal;
  resolve(value: Slide | null): void;
  reject(error: unknown): void;
}

/** A loader whose loads settle only when the test says so. */
function harness(concurrency = 2) {
  const pending: Pending[] = [];
  const released: Slide[] = [];
  const onChange = vi.fn();
  const onError = vi.fn();
  const load = vi.fn(
    (stageId: string, _version: number, signal: AbortSignal) =>
      new Promise<Slide | null>((resolve, reject) => {
        pending.push({ stageId, signal, resolve, reject });
      }),
  );
  const loader = new CourseThumbnailLoader({
    load,
    release: (s) => released.push(s),
    concurrency,
    onChange,
    onError,
  });
  const settle = async (stageId: string, value: Slide | null | Error) => {
    const index = pending.findIndex((p) => p.stageId === stageId);
    if (index === -1) throw new Error(`no pending load for ${stageId}`);
    const [p] = pending.splice(index, 1);
    if (value instanceof Error) p.reject(value);
    else p.resolve(value);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { loader, load, pending, released, onChange, onError, settle };
}

describe('CourseThumbnailLoader', () => {
  it('runs at most `concurrency` loads at once and starts the next as one settles', async () => {
    const h = harness(2);
    for (const id of ['a', 'b', 'c', 'd']) h.loader.request(id, 1);

    expect(h.load.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);

    await h.settle('a', slide('a'));
    expect(h.load.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
    expect(h.loader.snapshot()).toEqual({ a: slide('a') });

    await h.settle('b', null);
    await h.settle('c', slide('c'));
    await h.settle('d', slide('d'));
    expect(h.load).toHaveBeenCalledTimes(4);
    expect(h.loader.snapshot()).toEqual({ a: slide('a'), b: null, c: slide('c'), d: slide('d') });
  });

  it('drops a queued load once every requester withdrew, but finishes one in flight', async () => {
    const h = harness(1);
    const withdrawA = h.loader.request('a', 1);
    const withdrawB = h.loader.request('b', 1);
    const withdrawB2 = h.loader.request('b', 1);
    h.loader.request('c', 1);

    withdrawA();
    withdrawB();
    await h.settle('a', slide('a'));
    // `b` still has one requester.
    expect(h.load.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(h.loader.snapshot()).toEqual({ a: slide('a') });

    withdrawB2();
    await h.settle('b', slide('b'));
    expect(h.load.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  });

  it('never loads a withdrawn queued course', async () => {
    const h = harness(1);
    h.loader.request('a', 1);
    h.loader.request('b', 1)();
    await h.settle('a', slide('a'));
    expect(h.load.mock.calls.map(([id]) => id)).toEqual(['a']);
  });

  it('loads a version once, and reloads a newer one while the previous stays visible', async () => {
    const h = harness(2);
    h.loader.request('a', 1);
    h.loader.request('a', 1);
    await h.settle('a', slide('a1'));
    h.loader.request('a', 1);
    expect(h.load).toHaveBeenCalledTimes(1);

    h.loader.request('a', 2);
    expect(h.load).toHaveBeenCalledTimes(2);
    // Each load is told the version it is for.
    expect(h.load.mock.calls.map(([id, version]) => [id, version])).toEqual([
      ['a', 1],
      ['a', 2],
    ]);
    expect(h.loader.snapshot()).toEqual({ a: slide('a1') });
    expect(h.released).toEqual([]);

    await h.settle('a', slide('a2'));
    expect(h.loader.snapshot()).toEqual({ a: slide('a2') });
    expect(h.released).toEqual([slide('a1')]);
  });

  it('keeps the previous thumbnail when a reload fails, and reports the failure', async () => {
    const h = harness(1);
    h.loader.request('a', 1);
    await h.settle('a', slide('a1'));
    h.loader.request('a', 2);
    await h.settle('a', new Error('offline'));

    expect(h.onError).toHaveBeenCalledWith('a', expect.any(Error));
    expect(h.loader.snapshot()).toEqual({ a: slide('a1') });
    expect(h.released).toEqual([]);
    // The failed version is not retried until the course changes again.
    h.loader.request('a', 2);
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it('records a first-load failure as no thumbnail', async () => {
    const h = harness(1);
    h.loader.request('a', 1);
    await h.settle('a', new Error('offline'));
    expect(h.loader.snapshot()).toEqual({ a: null });
  });

  it('dispose drops the queue, aborts loads in flight, and releases everything', async () => {
    const h = harness(1);
    h.loader.request('a', 1);
    await h.settle('a', slide('a'));
    h.loader.request('b', 1);
    h.loader.request('c', 1);
    const inFlight = h.pending[0]!;
    h.onChange.mockClear();

    h.loader.dispose();

    expect(inFlight.signal.aborted).toBe(true);
    expect(h.released).toEqual([slide('a')]);
    expect(h.loader.snapshot()).toEqual({});
    // The aborted load settling late is discarded and released, and the
    // queued course never starts.
    await h.settle('b', slide('b'));
    expect(h.released).toEqual([slide('a'), slide('b')]);
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    // Requests after dispose are ignored.
    h.loader.request('d', 1);
    expect(h.load).toHaveBeenCalledTimes(2);
  });

  it('retain forgets and releases thumbnails of courses no longer listed', async () => {
    const h = harness(2);
    h.loader.request('a', 1);
    h.loader.request('b', 1);
    await h.settle('a', slide('a'));
    await h.settle('b', slide('b'));

    h.loader.retain(new Set(['b']));

    expect(h.loader.snapshot()).toEqual({ b: slide('b') });
    expect(h.released).toEqual([slide('a')]);
  });

  it('rejects a non-positive concurrency', () => {
    expect(
      () =>
        new CourseThumbnailLoader({
          load: async () => null,
          release: () => {},
          concurrency: 0,
          onChange: () => {},
        }),
    ).toThrow(/concurrency/);
  });
});
