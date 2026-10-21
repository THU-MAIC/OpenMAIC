/**
 * The run's extraction watcher: it reports each watched source's settlement
 * once, keeps trying after a failed read, polls only while something is
 * watched, and stops for good with the run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startExtractionWatcher } from '@/lib/server/agent-runtime/extraction-watcher';

describe('extraction watcher', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports each watched source once, when it settles', async () => {
    vi.useFakeTimers();
    let settledNow: string[] = [];
    const readSettled = vi.fn(async (ids: readonly string[]) =>
      ids.filter((id) => settledNow.includes(id)),
    );
    const onSettled = vi.fn();
    const watcher = startExtractionWatcher({ readSettled, onSettled, intervalMs: 100 });

    // Nothing watched: no reads.
    await vi.advanceTimersByTimeAsync(500);
    expect(readSettled).not.toHaveBeenCalled();

    watcher.watch(['a', 'b']);
    await vi.advanceTimersByTimeAsync(100);
    expect(onSettled).not.toHaveBeenCalled();
    settledNow = ['a'];
    await vi.advanceTimersByTimeAsync(100);
    expect(onSettled).toHaveBeenCalledWith(['a']);
    settledNow = ['a', 'b'];
    await vi.advanceTimersByTimeAsync(100);
    expect(onSettled).toHaveBeenLastCalledWith(['b']);
    expect(onSettled).toHaveBeenCalledTimes(2);

    // Nothing left to watch: reads stop.
    const reads = readSettled.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(readSettled).toHaveBeenCalledTimes(reads);
    watcher.stop();
  });

  it('reports what a wait saw settle, only for watched sources, and only once', () => {
    const onSettled = vi.fn();
    const watcher = startExtractionWatcher({
      readSettled: async () => [],
      onSettled,
      intervalMs: 60_000,
    });
    watcher.watch(['a']);
    watcher.settled(['a', 'never-watched']);
    watcher.settled(['a']);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(['a']);
    watcher.stop();
  });

  it('tries again after a failed read', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const readSettled = vi
      .fn<(ids: readonly string[]) => Promise<string[]>>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue(['a']);
    const onSettled = vi.fn();
    const watcher = startExtractionWatcher({ readSettled, onSettled, intervalMs: 100 });
    watcher.watch(['a']);
    await vi.advanceTimersByTimeAsync(100);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(onSettled).toHaveBeenCalledWith(['a']);
    watcher.stop();
  });

  it('does not let an old wait settle a freshly registered retry', () => {
    const onSettled = vi.fn();
    const watcher = startExtractionWatcher({ readSettled: async () => [], onSettled });
    watcher.watch(['a']);
    const old = watcher.observe();
    watcher.watch(['a']);
    old.settled(['a']);
    expect(onSettled).not.toHaveBeenCalled();
    watcher.observe().settled(['a']);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(['a']);
    watcher.stop();
  });

  it('ignores an in-flight poll and retained observations after stop', async () => {
    vi.useFakeTimers();
    let release!: (ids: string[]) => void;
    const pending = new Promise<string[]>((resolve) => {
      release = resolve;
    });
    const onSettled = vi.fn();
    const readSettled = vi.fn(() => pending);
    const watcher = startExtractionWatcher({ readSettled, onSettled, intervalMs: 100 });
    watcher.watch(['a']);
    const observation = watcher.observe();
    await vi.advanceTimersByTimeAsync(100);
    expect(readSettled).toHaveBeenCalledTimes(1);
    watcher.stop();
    observation.watch(['a']);
    observation.settled(['a']);
    release(['a']);
    await vi.advanceTimersByTimeAsync(500);
    expect(onSettled).not.toHaveBeenCalled();
    expect(readSettled).toHaveBeenCalledTimes(1);
  });

  it('stops for good with the run', async () => {
    vi.useFakeTimers();
    const readSettled = vi.fn(async (ids: readonly string[]) => [...ids]);
    const onSettled = vi.fn();
    const watcher = startExtractionWatcher({ readSettled, onSettled, intervalMs: 100 });
    watcher.watch(['a']);
    watcher.stop();
    watcher.watch(['b']);
    watcher.settled(['a', 'b']);
    await vi.advanceTimersByTimeAsync(500);
    expect(readSettled).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
