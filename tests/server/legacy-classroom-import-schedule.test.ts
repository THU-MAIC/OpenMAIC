/**
 * The startup schedule of the legacy classroom import: a run that cannot start
 * or does not complete is retried with backoff, in this process, until one
 * completes; stopping aborts the run in progress and waits for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startLegacyClassroomImport,
  type LegacyClassroomImportSummary,
} from '@/lib/server/legacy-classroom-import';

function summary(extra: Partial<LegacyClassroomImportSummary> = {}): LegacyClassroomImportSummary {
  return {
    found: 1,
    imported: 0,
    alreadySettled: 0,
    skipped: 0,
    failed: 0,
    mediaStored: 0,
    mediaMissing: 0,
    ...extra,
  };
}

describe('startLegacyClassroomImport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries with backoff until a run completes, then stops', async () => {
    const run = vi
      .fn<(signal: AbortSignal) => Promise<LegacyClassroomImportSummary>>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockResolvedValueOnce(summary({ failed: 1 }))
      .mockResolvedValueOnce(summary({ interrupted: 'storage-full' }))
      .mockResolvedValueOnce(summary({ interrupted: 'lock-busy' }))
      .mockResolvedValue(summary({ imported: 1 }));

    startLegacyClassroomImport(run);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    // The delay doubles after each incomplete run.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(run).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('runs once when the first run completes', async () => {
    const run = vi.fn(async () => summary({ imported: 1 }));
    startLegacyClassroomImport(run);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() aborts the run in progress, waits for it, and schedules nothing', async () => {
    let finish!: () => void;
    let seen: AbortSignal | undefined;
    const run = vi.fn(async (signal: AbortSignal) => {
      seen = signal;
      await new Promise<void>((resolve) => (finish = resolve));
      return summary({ interrupted: signal.aborted ? 'stopped' : undefined });
    });
    const schedule = startLegacyClassroomImport(run);
    await vi.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = schedule.stop().then(() => (stopped = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen?.aborted).toBe(true);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
