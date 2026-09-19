/**
 * Unit tests for the manifest / batch fetch classification and the batch
 * chunking (cr D1-F2 / D3-F1):
 *
 *  - `fetchStageManifest` answers a TRI-STATE: structural `missing` (404 /
 *    non-live build) vs `transient` (-live 5xx / network / malformed body)
 *    vs `ok`. The save-path veto depends on telling "nothing to protect"
 *    apart from "the server MAY be ahead — do not write".
 *  - `fetchScenesByIds` chunks below the server's per-request cap, so a real
 *    course of a few hundred scenes never trips the endpoint's 400.
 *
 * Criterion discipline: every assertion uses LITERAL values (200 / 404 / 500),
 * never constants imported from the implementation under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchScenesByIds,
  fetchStageManifest,
  type StageManifest,
} from '@/lib/workbench/stage-freshness';

// Upstream adaptation: the reference had a `vi.mock('@/lib/live-mode')` here
// and a D1-F5 case asserting that a non-live build short-circuits before any
// request. The live-mode flag is a dropped live-only concern in this port, so
// the mock and that case are gone; a 404 (the current state while the stage
// manifest/scenes routes do not exist yet) classifies as `missing`, which is
// the same fail-open outcome the reference's non-live branch produced.

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function stubFetch(impl: (url: string) => Promise<unknown>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => impl(String(input)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const manifestBody: StageManifest = {
  rev: 7,
  scenes: [
    { id: 'scene-1', order: 0, rev: 1 },
    { id: 'scene-2', order: 1, rev: 1 },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchStageManifest — 结构性缺失 vs 瞬时故障 vs ok', () => {
  it('200 + 合法 body → ok', async () => {
    const fetchMock = stubFetch(async () => okJson(manifestBody));
    const result = await fetchStageManifest('stage-a');
    expect(result).toEqual({ status: 'ok', manifest: manifestBody });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('/api/stages/stage-a/manifest'),
      { credentials: 'include' },
    );
  });

  it('404 → missing（结构性缺失：无更老的服务器状态需要保护，保存放行）', async () => {
    stubFetch(async () => ({ ok: false, status: 404 }));
    const result = await fetchStageManifest('stage-a');
    expect(result).toEqual({ status: 'missing' });
  });

  it('5xx → transient（-live 瞬时故障：服务器可能领先于浏览器，保存不放行）', async () => {
    stubFetch(async () => ({ ok: false, status: 500 }));
    const result = await fetchStageManifest('stage-a');
    expect(result).toEqual({ status: 'transient' });
  });

  it('网络错误 → transient', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await fetchStageManifest('stage-a');
    expect(result).toEqual({ status: 'transient' });
  });

  it('畸形 body（scenes 不是数组）→ transient', async () => {
    stubFetch(async () => okJson({ rev: 1, scenes: 'nope' }));
    const result = await fetchStageManifest('stage-a');
    expect(result).toEqual({ status: 'transient' });
  });
});

describe('fetchScenesByIds — 分块不超过服务端批量上限', () => {
  function seedScenes(count: number) {
    const ids = Array.from({ length: count }, (_, i) => `c-${String(i).padStart(4, '0')}`);
    const byId = new Map(
      ids.map((id, i) => [id, { id, stageId: 'stage-a', order: i, title: id, type: 'slide' }]),
    );
    return { ids, byId };
  }

  it('250 个 id → 切成 ≤200 的请求块（字面量 200），结果合并完整', async () => {
    const { ids, byId } = seedScenes(250);
    const requested: string[][] = [];
    const fetchMock = stubFetch(async (url) => {
      const chunk = new URL(url, 'http://localhost').searchParams.get('ids')!.split(',');
      requested.push(chunk);
      // Matches the production endpoint: a chunk over the cap returns 400 — if
      // chunking ever fell back to a single request, this mock would 400.
      if (chunk.length > 200) return { ok: false, status: 400 };
      return okJson({ scenes: chunk.map((id) => byId.get(id)).filter(Boolean) });
    });

    const scenes = await fetchScenesByIds('stage-a', ids);

    // Criterion 1 (mechanism): chunked requests — no chunk exceeds 200 ids.
    expect(requested.length).toBe(2);
    for (const chunk of requested) expect(chunk.length).toBeLessThanOrEqual(200);
    // Criterion 2 (effect): the results merge completely, in server order.
    expect(scenes.map((s) => s.id)).toEqual(ids);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('部分块失败 → 返回成功块的场景（未拿到的 id 留给下一 diff 重试）', async () => {
    const { ids, byId } = seedScenes(250);
    let call = 0;
    stubFetch(async (url) => {
      call += 1;
      const chunk = new URL(url, 'http://localhost').searchParams.get('ids')!.split(',');
      if (call === 2) return { ok: false, status: 500 }; // second chunk transient failure
      return okJson({ scenes: chunk.map((id) => byId.get(id)).filter(Boolean) });
    });

    const scenes = await fetchScenesByIds('stage-a', ids);

    expect(scenes).toHaveLength(200); // only the first chunk's scenes
    expect(scenes.map((s) => s.id)).toEqual(ids.slice(0, 200));
  });

  it('全部块失败 → []（调用方据此中止本 pass，不推进基线）', async () => {
    const { ids } = seedScenes(250);
    stubFetch(async () => ({ ok: false, status: 500 }));
    const scenes = await fetchScenesByIds('stage-a', ids);
    expect(scenes).toEqual([]);
  });
});
