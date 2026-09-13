/**
 * #1450: a transient /api/classroom failure must not be reported as "course
 * does not exist". The fetch seam classifies HTTP answers into found / absent /
 * unavailable so ClassroomSurface can keep notFound for positive absence only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchClassroomFromApi, type ClassroomFetchResult } from '@/lib/classroom/load-classroom';

describe('fetchClassroomFromApi outcome classification (#1450)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns found when the classroom payload is present', async () => {
    const classroom = {
      stage: { id: 'stage-1', name: 'Demo', createdAt: 1, updatedAt: 1 },
      scenes: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, classroom }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(fetchClassroomFromApi('stage-1')).resolves.toEqual({
      outcome: 'found',
      classroom,
    } satisfies ClassroomFetchResult);
  });

  it('returns absent on 404 (and 410 tombstone)', async () => {
    for (const status of [404, 410] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'not found' }), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      await expect(fetchClassroomFromApi('stage-missing')).resolves.toEqual({
        outcome: 'absent',
      });
    }
  });

  it('returns unavailable on 5xx instead of collapsing to absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(fetchClassroomFromApi('stage-live')).resolves.toEqual({
      outcome: 'unavailable',
      status: 503,
    });
  });

  it('returns unavailable on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(fetchClassroomFromApi('stage-live')).resolves.toEqual({
      outcome: 'unavailable',
    });
  });

  it('returns absent when a 200 body lacks a classroom (authoritative miss)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(fetchClassroomFromApi('stage-empty')).resolves.toEqual({
      outcome: 'absent',
    });
  });
});
