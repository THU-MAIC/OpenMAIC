import { describe, it, expect } from 'vitest';
import { resolveSceneOutline } from '@/lib/agent/client/resolve-scene-outline';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

const outline = (id: string, order: number, title: string): SceneOutline =>
  ({ id, order, title, type: 'slide', description: '', keyPoints: [] }) as SceneOutline;

const scene = (over: Partial<Scene>): Scene =>
  ({
    id: 's',
    stageId: 'stage',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions: [],
    ...over,
  }) as unknown as Scene;

describe('resolveSceneOutline', () => {
  it('matches by stable outlineId — survives a reorder that rebalances order', () => {
    // Generation plan: outline A is slide 1, outline B is slide 2.
    const outlines = [outline('oA', 1, 'Intro'), outline('oB', 2, 'Deep dive')];
    // After the user drags slide B to the front, B's scene.order is now 1 — but
    // it was generated from outline B. An order match would wrongly return oA.
    const reordered = scene({ id: 'sB', outlineId: 'oB', order: 1, title: 'Deep dive' });

    const resolved = resolveSceneOutline(reordered, outlines);

    expect(resolved.id).toBe('oB');
    expect(resolved.title).toBe('Deep dive');
  });

  it('falls back to a scene-derived outline when the scene has no outlineId', () => {
    const outlines = [outline('oA', 1, 'Intro')];
    const inserted = scene({ id: 'sNew', outlineId: undefined, order: 1, title: 'Fresh slide' });

    const resolved = resolveSceneOutline(inserted, outlines);

    // Never another slide's outline — derived from the scene itself.
    expect(resolved.id).toBe('sNew');
    expect(resolved.title).toBe('Fresh slide');
    expect(resolved.keyPoints).toEqual([]);
  });

  it('falls back to scene-derived when outlineId points at a removed outline', () => {
    const outlines = [outline('oA', 1, 'Intro')];
    const orphan = scene({ id: 'sX', outlineId: 'gone', order: 2, title: 'Orphan' });

    const resolved = resolveSceneOutline(orphan, outlines);

    expect(resolved.id).toBe('sX');
    expect(resolved.title).toBe('Orphan');
  });
});
