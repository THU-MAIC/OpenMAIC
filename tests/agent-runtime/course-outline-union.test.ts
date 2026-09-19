/**
 * The shared outline/scene union merge (`mergeStageOutline`) — the single
 * algorithm behind `read_stage_outline` and `generate_actions`' course
 * context. Every boundary the review probed is pinned here as a semantics
 * table (input → output), so a future edit of one consumer cannot silently
 * diverge from the other.
 */
import { describe, expect, it } from 'vitest';

import {
  mergeStageOutline,
  type OutlineSceneLike,
  type OutlineUnionEntry,
} from '@/lib/server/agent-runtime/course-outline-union';
import type { SceneOutline } from '@/lib/types/generation';

function scene(
  overrides: Partial<OutlineSceneLike> & Pick<OutlineSceneLike, 'id' | 'order' | 'title'>,
): OutlineSceneLike {
  return { type: 'slide', ...overrides };
}

function outline(
  overrides: Partial<SceneOutline> & Pick<SceneOutline, 'id' | 'order' | 'title'>,
): SceneOutline {
  return { type: 'slide', description: `brief-of-${overrides.title}`, keyPoints: [], ...overrides };
}

const rows = (
  entries: OutlineUnionEntry[],
): { order: number; title: string; planned?: boolean; description?: string }[] =>
  entries.map(({ order, title, planned, description }) => ({ order, title, planned, description }));

describe('mergeStageOutline — the shared outline/scene union', () => {
  it('empty scenes + incomplete plan → every plan entry as planned', () => {
    const merged = mergeStageOutline({
      scenes: [],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
      ],
      generationComplete: false,
    });
    expect(rows(merged)).toEqual([
      { order: 1, title: 'A', planned: true, description: 'brief-of-A' },
      { order: 2, title: 'B', planned: true, description: 'brief-of-B' },
    ]);
  });

  it('empty scenes + completed → pure scenes (empty), stale plan never resurface', () => {
    const merged = mergeStageOutline({
      scenes: [],
      planned: [outline({ id: 'p1', order: 1, title: 'A' })],
      generationComplete: true,
    });
    expect(merged).toEqual([]);
  });

  it('no plan (imported course) + scenes → real pages only, title fallback brief', () => {
    const merged = mergeStageOutline({
      scenes: [scene({ id: 's2', order: 2, title: 'Second' })],
      planned: [],
      generationComplete: false,
    });
    expect(rows(merged)).toEqual([{ order: 2, title: 'Second', description: 'Second' }]);
  });

  it('scenes [1] + plan [1,2,3] incomplete → [real 1, planned 2, planned 3]', () => {
    const merged = mergeStageOutline({
      scenes: [scene({ id: 's1', order: 1, title: 'A', outlineId: 'p1' })],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
        outline({ id: 'p3', order: 3, title: 'C' }),
      ],
      generationComplete: false,
    });
    expect(rows(merged)).toEqual([
      { order: 1, title: 'A', description: 'brief-of-A' },
      { order: 2, title: 'B', planned: true, description: 'brief-of-B' },
      { order: 3, title: 'C', planned: true, description: 'brief-of-C' },
    ]);
  });

  it('scenes [2] + plan [1,2,3] incomplete → [planned 1, real 2, planned 3] — order pairing', () => {
    const merged = mergeStageOutline({
      // No outlineId: a pre-existing scene must pair with plan slot 2 BY ORDER.
      scenes: [scene({ id: 's2', order: 2, title: 'Second' })],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
        outline({ id: 'p3', order: 3, title: 'C' }),
      ],
      generationComplete: false,
    });
    expect(rows(merged)).toEqual([
      { order: 1, title: 'A', planned: true, description: 'brief-of-A' },
      // The real page is the middle of the merged course and carries the
      // matched slot's brief (the ORDER pairing attached p2 to it).
      { order: 2, title: 'Second', description: 'brief-of-B' },
      { order: 3, title: 'C', planned: true, description: 'brief-of-C' },
    ]);
  });

  it('scenes [2,3] + plan [1,2,3] incomplete → [planned 1, real 2, real 3] — no FIRST mislabel', () => {
    const merged = mergeStageOutline({
      scenes: [
        scene({ id: 's2', order: 2, title: 'Second' }),
        scene({ id: 's3', order: 3, title: 'Third' }),
      ],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
        outline({ id: 'p3', order: 3, title: 'C' }),
      ],
      generationComplete: false,
    });
    const entries = rows(merged);
    expect(entries.map((e) => e.title)).toEqual(['A', 'Second', 'Third']);
    expect(entries.map((e) => e.order)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.planned)).toEqual([true, undefined, undefined]);
    // Real page 2 would render "Position: Page 2 of 3".
    expect(entries[1]?.description).toBe('brief-of-B');
  });

  it('scene@1 without outlineId + plan [1,2] incomplete → [real 1, planned 2], no [1,1,2] duplicate', () => {
    const merged = mergeStageOutline({
      scenes: [scene({ id: 's1', order: 1, title: 'A' })],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
      ],
      generationComplete: false,
    });
    const entries = rows(merged);
    expect(entries.map((e) => e.order)).toEqual([1, 2]);
    expect(entries.map((e) => e.title)).toEqual(['A', 'B']);
    expect(entries.map((e) => e.planned)).toEqual([undefined, true]);
  });

  it('duplicated outlineId consumes only the FIRST plan entry — the twin stays planned', () => {
    const merged = mergeStageOutline({
      scenes: [scene({ id: 's1', order: 1, title: 'One', outlineId: 'dup' })],
      planned: [
        outline({ id: 'dup', order: 1, title: 'One' }),
        outline({ id: 'dup', order: 2, title: 'Two' }),
      ],
      generationComplete: false,
    });
    const entries = rows(merged);
    expect(entries.map((e) => e.title)).toEqual(['One', 'Two']);
    expect(entries.map((e) => e.planned)).toEqual([undefined, true]);
    expect(entries[1]?.description).toBe('brief-of-Two');
  });

  it('two scenes sharing a duplicated outlineId: only the first consumes by id, the second re-pairs by order', () => {
    const merged = mergeStageOutline({
      scenes: [
        scene({ id: 's1', order: 1, title: 'One', outlineId: 'dup' }),
        scene({ id: 's2', order: 2, title: 'Two', outlineId: 'dup' }),
      ],
      planned: [
        outline({ id: 'dup', order: 1, title: 'One' }),
        outline({ id: 'dup', order: 2, title: 'Two' }),
      ],
      generationComplete: false,
    });
    const entries = rows(merged);
    expect(entries.map((e) => e.title)).toEqual(['One', 'Two']);
    // Both real pages matched (the second by order), so nothing stays planned.
    expect(entries.map((e) => e.planned)).toEqual([undefined, undefined]);
    expect(entries.map((e) => e.description)).toEqual(['brief-of-One', 'brief-of-Two']);
  });

  it('real page wins the shared order; the planned entry defers — display stays 1..N (conflict merge)', () => {
    // Drifted plan [A@1, B@2, C@2, D@3] with a real page X@2 matched to C by
    // id: the unpaired B@2 defers AFTER the real page, display never repeats.
    const merged = mergeStageOutline({
      scenes: [scene({ id: 'sx', order: 2, title: 'X', outlineId: 'p3' })],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
        outline({ id: 'p3', order: 2, title: 'C' }),
        outline({ id: 'p4', order: 3, title: 'D' }),
      ],
      generationComplete: false,
    });
    const entries = rows(merged);
    // Display order: A(planned), X(real, matched to C), B(deferred planned), D.
    expect(entries.map((e) => e.title)).toEqual(['A', 'X', 'B', 'D']);
    // Entries keep their ORIGINAL order (2 appears twice) but the display
    // positions are consecutive 1..4 — no duplicated page numbers.
    expect(entries.map((e) => e.order)).toEqual([1, 2, 2, 3]);
    expect(entries.map((e) => e.planned)).toEqual([true, undefined, true, true]);
    expect(entries[1]?.description).toBe('brief-of-C');
  });

  it('a completed snapshot is pure scenes — but matched real pages keep the snapshot brief', () => {
    const merged = mergeStageOutline({
      scenes: [scene({ id: 's1', order: 1, title: 'A', outlineId: 'p1' })],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
      ],
      generationComplete: true,
    });
    const entries = rows(merged);
    expect(entries.map((e) => e.title)).toEqual(['A']);
    expect(entries.map((e) => e.planned)).toEqual([undefined]);
    expect(entries[0]?.description).toBe('brief-of-A');
  });

  it('an outlineId that exists nowhere in the plan falls back to order pairing', () => {
    const merged = mergeStageOutline({
      scenes: [scene({ id: 's2', order: 2, title: 'Second', outlineId: 'ghost' })],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
      ],
      generationComplete: false,
    });
    const entries = rows(merged);
    expect(entries.map((e) => e.title)).toEqual(['A', 'Second']);
    expect(entries.map((e) => e.planned)).toEqual([true, undefined]);
    expect(entries[1]?.description).toBe('brief-of-B');
  });

  it('generationComplete undefined (client-minted course) is finished intent: pure scenes', () => {
    const merged = mergeStageOutline({
      scenes: [scene({ id: 's1', order: 1, title: 'A' })],
      planned: [
        outline({ id: 'p1', order: 1, title: 'A' }),
        outline({ id: 'p2', order: 2, title: 'B' }),
      ],
    });
    expect(merged.map((e) => e.title)).toEqual(['A']);
    expect(merged.every((e) => e.planned === undefined)).toBe(true);
  });
});
