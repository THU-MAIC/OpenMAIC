import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeStore } from '@openmaic/storage';

import {
  configureRuntimeStorage,
  deleteStageRuntimeSafely,
  resetRuntimeStorageForTests,
} from '@/lib/runtime/store';

function stubStore(deleteStageRuntime: (stageId: string) => Promise<void>): RuntimeStore {
  return { deleteStageRuntime } as unknown as RuntimeStore;
}

describe('deleteStageRuntimeSafely', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('cascades through the configured runtime store', async () => {
    resetRuntimeStorageForTests();
    const deleteStageRuntime = vi.fn().mockResolvedValue(undefined);
    configureRuntimeStorage({ store: stubStore(deleteStageRuntime) });
    try {
      await deleteStageRuntimeSafely('stage-42');
      expect(deleteStageRuntime).toHaveBeenCalledExactlyOnceWith('stage-42');
    } finally {
      resetRuntimeStorageForTests();
    }
  });

  it('cascades the deletion to the runtime store with the right stageId', async () => {
    const deleteStageRuntime = vi.fn().mockResolvedValue(undefined);
    await deleteStageRuntimeSafely('stage-42', stubStore(deleteStageRuntime));
    expect(deleteStageRuntime).toHaveBeenCalledExactlyOnceWith('stage-42');
  });

  it('never throws when the runtime store fails; warns instead', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deleteStageRuntime = vi.fn().mockRejectedValue(new Error('runtime DB is broken'));

    await expect(
      deleteStageRuntimeSafely('stage-42', stubStore(deleteStageRuntime)),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0])).toContain('stage-42');
  });

  it('resolves after the timeout when the runtime store hangs', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const never = new Promise<void>(() => {});

    const pending = deleteStageRuntimeSafely(
      'stage-42',
      stubStore(() => never),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0])).toContain('stage-42');
  });

  it('a rejection landing after the timeout is not an unhandled rejection', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let rejectLate!: (error: Error) => void;
    const late = new Promise<void>((_, reject) => {
      rejectLate = reject;
    });
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);

    try {
      const pending = deleteStageRuntimeSafely(
        'stage-42',
        stubStore(() => late),
      );
      await vi.advanceTimersByTimeAsync(5000);
      await pending; // timed out and resolved; the cascade is still pending

      rejectLate(new Error('failed long after the deletion moved on'));
      // let the event loop reach the unhandled-rejection check
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
