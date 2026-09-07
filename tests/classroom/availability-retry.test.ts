import { describe, expect, it, vi } from 'vitest';
import {
  startClassroomAvailabilityPolling,
  type ClassroomAvailabilityOutcome,
} from '@/lib/classroom/progressive-load-policy';
import { fetchStageMeta } from '@/lib/classroom/stage-meta-client';
import { DocumentGoneError, HttpDocumentStore } from '@openmaic/storage';

describe('classroom availability retry and tombstone resolution', () => {
  describe('storage and sidecar 410 contract', () => {
    it('HttpDocumentStore.loadDocument returns null on 404 DOCUMENT_NOT_FOUND', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'DOCUMENT_NOT_FOUND', message: '@openmaic/storage: document not found' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      );

      const store = new HttpDocumentStore({
        baseUrl: 'http://localhost/api/persistence',
        fetch: fetchMock,
      });

      const result = await store.loadDocument('stage-never-existed');
      expect(result).toBeNull();
    });

    it('HttpDocumentStore.loadDocument throws DocumentGoneError on 410 DOCUMENT_GONE', async () => {
      const deletedAt = '2026-03-01T12:00:00.000Z';
      const fetchMock = vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'DOCUMENT_GONE',
                message: '@openmaic/storage: document is gone',
                deleted_at: deletedAt,
              },
              deleted_at: deletedAt,
            }),
            { status: 410, headers: { 'content-type': 'application/json' } },
          ),
      );

      const store = new HttpDocumentStore({
        baseUrl: 'http://localhost/api/persistence',
        fetch: fetchMock,
      });

      await expect(store.loadDocument('stage-deleted-id')).rejects.toThrow(DocumentGoneError);
      try {
        await store.loadDocument('stage-deleted-id');
      } catch (error) {
        expect(error).toBeInstanceOf(DocumentGoneError);
        expect((error as DocumentGoneError).stageId).toBe('stage-deleted-id');
        expect((error as DocumentGoneError).deletedAt).toBe(deletedAt);
      }
    });

    it('fetchStageMeta returns absent on 404 not_found', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await fetchStageMeta('stage-never-existed', fetchMock);
      expect(result).toEqual({ outcome: 'absent' });
    });

    it('fetchStageMeta returns gone with deletedAt on 410 gone', async () => {
      const deletedAt = '2026-03-01T12:00:00.000Z';
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'gone', deleted_at: deletedAt }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await fetchStageMeta('stage-deleted-id', fetchMock);
      expect(result).toEqual({ outcome: 'gone', deletedAt });
    });
  });

  describe('startClassroomAvailabilityPolling', () => {
    it('(a) polling a never-created id retries and times out to not-found after schedule exhaustion', async () => {
      const loadClassroom = vi
        .fn<() => Promise<ClassroomAvailabilityOutcome>>()
        .mockResolvedValue('unavailable');
      const onSuccess = vi.fn();
      const onDeleted = vi.fn();
      const onNotFoundTimeout = vi.fn();

      const scheduledDelays: number[] = [];
      const timerCallbacks: Array<() => void> = [];

      const mockSetTimeout = (callback: () => void, ms?: number) => {
        scheduledDelays.push(ms ?? 0);
        timerCallbacks.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      };

      startClassroomAvailabilityPolling({
        loadClassroom,
        onSuccess,
        onDeleted,
        onNotFoundTimeout,
        setTimeoutImpl: mockSetTimeout,
        clearTimeoutImpl: vi.fn(),
      });

      // Attempt 0 initial synchronous call
      await Promise.resolve();
      await Promise.resolve();
      expect(loadClassroom).toHaveBeenCalledTimes(1);
      expect(onNotFoundTimeout).not.toHaveBeenCalled();
      expect(scheduledDelays).toEqual([1_000]);

      // Trigger attempts 1 through 4 (delays: 2000, 4000, 8000, 16000)
      for (let attempt = 1; attempt <= 4; attempt++) {
        const nextCallback = timerCallbacks.shift()!;
        nextCallback();
        await Promise.resolve();
        await Promise.resolve();
        expect(loadClassroom).toHaveBeenCalledTimes(attempt + 1);
        expect(onNotFoundTimeout).not.toHaveBeenCalled();
      }

      expect(scheduledDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);

      // Trigger final attempt (attempt 5) -> delay becomes null -> onNotFoundTimeout is called!
      const finalCallback = timerCallbacks.shift()!;
      finalCallback();
      await Promise.resolve();
      await Promise.resolve();

      expect(loadClassroom).toHaveBeenCalledTimes(6);
      expect(onNotFoundTimeout).toHaveBeenCalledTimes(1);
      expect(onDeleted).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('(b) polling a freshly created id that becomes available succeeds and stops retrying', async () => {
      let attempts = 0;
      const loadClassroom = vi.fn(async () => {
        attempts += 1;
        // First attempt still propagating; second attempt succeeds!
        return attempts === 1 ? ('unavailable' as const) : ('loaded' as const);
      });

      const onSuccess = vi.fn();
      const onDeleted = vi.fn();
      const onNotFoundTimeout = vi.fn();

      const timerCallbacks: Array<() => void> = [];
      const mockSetTimeout = (callback: () => void) => {
        timerCallbacks.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      };

      startClassroomAvailabilityPolling({
        loadClassroom,
        onSuccess,
        onDeleted,
        onNotFoundTimeout,
        setTimeoutImpl: mockSetTimeout,
        clearTimeoutImpl: vi.fn(),
      });

      // Initial attempt (attempt 0)
      await Promise.resolve();
      await Promise.resolve();
      expect(loadClassroom).toHaveBeenCalledTimes(1);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(timerCallbacks.length).toBe(1);

      // Trigger retry timer -> attempt 1 succeeds
      const nextCallback = timerCallbacks.shift()!;
      nextCallback();
      await Promise.resolve();
      await Promise.resolve();

      expect(loadClassroom).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onDeleted).not.toHaveBeenCalled();
      expect(onNotFoundTimeout).not.toHaveBeenCalled();
      // No more timers scheduled
      expect(timerCallbacks.length).toBe(0);
    });

    it('(c) polling a deleted id returns 410 and immediately shows deleted state without retry timeout', async () => {
      const loadClassroom = vi
        .fn<() => Promise<ClassroomAvailabilityOutcome>>()
        .mockResolvedValue('deleted');
      const onSuccess = vi.fn();
      const onDeleted = vi.fn();
      const onNotFoundTimeout = vi.fn();
      const mockSetTimeout = vi.fn();

      startClassroomAvailabilityPolling({
        loadClassroom,
        onSuccess,
        onDeleted,
        onNotFoundTimeout,
        setTimeoutImpl: mockSetTimeout,
        clearTimeoutImpl: vi.fn(),
      });

      await Promise.resolve();
      await Promise.resolve();

      // Immediately called onDeleted
      expect(loadClassroom).toHaveBeenCalledTimes(1);
      expect(onDeleted).toHaveBeenCalledTimes(1);
      expect(mockSetTimeout).not.toHaveBeenCalled();
      expect(onNotFoundTimeout).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('cancelling availability polling halts further calls', async () => {
      const loadClassroom = vi
        .fn<() => Promise<ClassroomAvailabilityOutcome>>()
        .mockResolvedValue('unavailable');
      const onNotFoundTimeout = vi.fn();
      const mockClearTimeout = vi.fn();

      const timerCallbacks: Array<() => void> = [];
      const mockSetTimeout = (callback: () => void) => {
        timerCallbacks.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      };

      const cancel = startClassroomAvailabilityPolling({
        loadClassroom,
        onDeleted: vi.fn(),
        onNotFoundTimeout,
        setTimeoutImpl: mockSetTimeout,
        clearTimeoutImpl: mockClearTimeout,
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(loadClassroom).toHaveBeenCalledTimes(1);

      // Cancel before the timer fires
      cancel();
      expect(mockClearTimeout).toHaveBeenCalledWith(1 as unknown as ReturnType<typeof setTimeout>);

      // Attempting to invoke the callback after cancellation does not call loadClassroom
      const nextCallback = timerCallbacks.shift()!;
      nextCallback();
      await Promise.resolve();
      await Promise.resolve();

      expect(loadClassroom).toHaveBeenCalledTimes(1);
      expect(onNotFoundTimeout).not.toHaveBeenCalled();
    });
  });
});
