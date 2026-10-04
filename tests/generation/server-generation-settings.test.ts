/** The scene concurrency the server allows the browser (GET /api/health). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getParallelSceneConcurrency,
  resetServerGenerationSettingsForTests,
} from '@/lib/generation/server-generation-settings';

afterEach(() => {
  resetServerGenerationSettingsForTests();
  vi.unstubAllGlobals();
});

describe('getParallelSceneConcurrency', () => {
  it('reads the value once per page, clamped', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ generation: { parallelSceneConcurrency: 42 } }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await getParallelSceneConcurrency()).toBe(10);
    expect(await getParallelSceneConcurrency()).toBe(10);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps generation serial when the read fails, and reads again next time', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(Response.json({ generation: { parallelSceneConcurrency: 3 } }));
    vi.stubGlobal('fetch', fetch);
    expect(await getParallelSceneConcurrency()).toBe(0);
    expect(await getParallelSceneConcurrency()).toBe(3);
  });
});
