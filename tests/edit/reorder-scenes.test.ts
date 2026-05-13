import { describe, expect, test } from 'vitest';
import { reorderScene } from '@/lib/edit/reorder-scenes';
import { createDefaultSlide } from '@/lib/edit/slide-edit-elements';
import type { Scene } from '@/lib/types/stage';

function makeScene(id: string, order: number): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: 'slide',
    title: id,
    order,
    content: { type: 'slide', canvas: createDefaultSlide(`canvas-${id}`) },
  };
}

describe('reorderScene', () => {
  test('moves a scene up by swapping with its predecessor', () => {
    const scenes = [makeScene('a', 1), makeScene('b', 2), makeScene('c', 3)];

    const reordered = reorderScene(scenes, 'b', 'up');

    expect(reordered).not.toBeNull();
    expect(reordered!.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  test('moves a scene down by swapping with its successor', () => {
    const scenes = [makeScene('a', 1), makeScene('b', 2), makeScene('c', 3)];

    const reordered = reorderScene(scenes, 'b', 'down');

    expect(reordered).not.toBeNull();
    expect(reordered!.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  test('returns null when moving the first scene up', () => {
    const scenes = [makeScene('a', 1), makeScene('b', 2)];

    expect(reorderScene(scenes, 'a', 'up')).toBeNull();
  });

  test('returns null when moving the last scene down', () => {
    const scenes = [makeScene('a', 1), makeScene('b', 2)];

    expect(reorderScene(scenes, 'b', 'down')).toBeNull();
  });

  test('returns null when the sceneId is not found', () => {
    const scenes = [makeScene('a', 1), makeScene('b', 2)];

    expect(reorderScene(scenes, 'missing', 'up')).toBeNull();
    expect(reorderScene(scenes, 'missing', 'down')).toBeNull();
  });

  test('preserves positional order values, not per-scene values, after a swap', () => {
    // Non-contiguous order values (simulates a previous delete that left
    // sparse orders). After swapping a↔b, position 0 must keep order 1 and
    // position 1 must keep order 4 — so the persisted display sequence stays
    // {b, a, c}, not {a (order=4), b (order=1), c} which would re-sort to {b,
    // a, c} only by accident.
    const scenes = [makeScene('a', 1), makeScene('b', 4), makeScene('c', 7)];

    const reordered = reorderScene(scenes, 'a', 'down')!;

    expect(reordered.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(reordered.map((s) => s.order)).toEqual([1, 4, 7]);
  });

  test('does not mutate the input array', () => {
    const scenes = [makeScene('a', 1), makeScene('b', 2)];
    const snapshot = scenes.map((s) => ({ id: s.id, order: s.order }));

    reorderScene(scenes, 'a', 'down');

    expect(scenes.map((s) => ({ id: s.id, order: s.order }))).toEqual(snapshot);
  });

  test('returns null in both directions for a single-element list', () => {
    const scenes = [makeScene('a', 1)];

    expect(reorderScene(scenes, 'a', 'up')).toBeNull();
    expect(reorderScene(scenes, 'a', 'down')).toBeNull();
  });

  test('returns a new array reference (never the input)', () => {
    const scenes = [makeScene('a', 1), makeScene('b', 2)];

    const reordered = reorderScene(scenes, 'a', 'down');

    expect(reordered).not.toBe(scenes);
  });
});
