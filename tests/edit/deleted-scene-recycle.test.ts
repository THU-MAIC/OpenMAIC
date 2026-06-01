import { afterEach, describe, expect, it } from 'vitest';
import { useDeletedSceneRecycle } from '@/lib/edit/deleted-scene-recycle';
import type { Scene } from '@/lib/types/stage';

function makeScene(id: string, stageId = 'stage-1'): Scene {
  return {
    id,
    stageId,
    type: 'slide',
    title: 'T',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'c',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  };
}

afterEach(() => {
  useDeletedSceneRecycle.getState().clear();
});

describe('useDeletedSceneRecycle', () => {
  it('captures a scene with its original index', () => {
    const s = makeScene('a');
    useDeletedSceneRecycle.getState().capture(s, 3);
    const pending = useDeletedSceneRecycle.getState().pending;
    expect(pending?.scene).toBe(s);
    expect(pending?.index).toBe(3);
    expect(pending?.stageId).toBe('stage-1');
  });

  it('consume returns the entry and clears the slot', () => {
    const s = makeScene('a');
    useDeletedSceneRecycle.getState().capture(s, 2);
    const entry = useDeletedSceneRecycle.getState().consume();
    expect(entry?.scene).toBe(s);
    expect(useDeletedSceneRecycle.getState().pending).toBeNull();
  });

  it('consume returns null when no entry is pending', () => {
    expect(useDeletedSceneRecycle.getState().consume()).toBeNull();
  });

  it('a second capture evicts the previous pending entry', () => {
    const first = makeScene('a');
    const second = makeScene('b');
    useDeletedSceneRecycle.getState().capture(first, 0);
    useDeletedSceneRecycle.getState().capture(second, 5);
    const pending = useDeletedSceneRecycle.getState().pending;
    expect(pending?.scene).toBe(second);
    expect(pending?.index).toBe(5);
  });

  it('clear empties the slot without returning anything', () => {
    useDeletedSceneRecycle.getState().capture(makeScene('a'), 0);
    useDeletedSceneRecycle.getState().clear();
    expect(useDeletedSceneRecycle.getState().pending).toBeNull();
  });
});
