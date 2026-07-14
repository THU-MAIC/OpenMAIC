import { describe, it, expect, vi, afterEach } from 'vitest';
import { persistClassroomToServer } from '@/lib/hooks/classroom-persistence';
import type { Stage, Scene } from '@/lib/types/stage';

const stage = { id: 'abc' } as unknown as Stage;
const scenes = [] as unknown as Scene[];

function mockFetchOnce(response: Partial<Response> & { json: () => Promise<unknown> }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('persistClassroomToServer', () => {
  it('returns success on a 2xx response', async () => {
    mockFetchOnce({
      ok: true,
      status: 201,
      json: async () => ({ success: true, id: 'abc', url: '/classroom/abc' }),
    });

    const result = await persistClassroomToServer(stage, scenes);

    expect(result.success).toBe(true);
    expect(result.url).toBe('/classroom/abc');
  });

  it('returns failure on a non-2xx response instead of reporting success', async () => {
    // fetch() resolves normally for 4xx/5xx, so the helper must check response.ok.
    mockFetchOnce({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'disk write failed' }),
    });

    const result = await persistClassroomToServer(stage, scenes);

    expect(result.success).toBe(false);
    expect(result.error).toBe('disk write failed');
  });

  it('treats an API body with success:false as a failure even on a 2xx status', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: false, error: 'validation failed' }),
    });

    const result = await persistClassroomToServer(stage, scenes);

    expect(result.success).toBe(false);
    expect(result.error).toBe('validation failed');
  });

  it('falls back to the HTTP status when the error body has no message', async () => {
    mockFetchOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });

    const result = await persistClassroomToServer(stage, scenes);

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 502');
  });

  it('returns failure instead of throwing when fetch itself rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const result = await persistClassroomToServer(stage, scenes);

    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
  });

  // #53: a slow first-scene write must never overwrite the completed deck. We gate the
  // one-scene fetch so it resolves after the completion fetch is issued; the per-stage
  // chain must still commit them in order (one scene, then the full deck).
  it('serializes writes per stage so a deferred first-scene POST cannot overwrite the final deck', async () => {
    const raceStage = { id: 'race' } as unknown as Stage;
    const oneScene = [{}] as unknown as Scene[];
    const fullDeck = [{}, {}, {}] as unknown as Scene[];

    const committed: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { scenes: unknown[] };
        const count = body.scenes.length;
        if (count === 1) await firstGate;
        committed.push(count);
        return {
          ok: true,
          status: 201,
          json: async () => ({ success: true, url: '/classroom/race' }),
        } as Response;
      }),
    );

    const first = persistClassroomToServer(raceStage, oneScene);
    const completion = persistClassroomToServer(raceStage, fullDeck);

    // completion must wait behind the still-gated first-scene write
    await Promise.resolve();
    expect(committed).toEqual([]);

    releaseFirst();
    await Promise.all([first, completion]);

    // full deck is the last snapshot the server sees, never the stale one-scene payload
    expect(committed).toEqual([1, 3]);
  });
});
