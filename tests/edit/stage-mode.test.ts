import { beforeEach, describe, expect, test } from 'vitest';
import { useCanvasStore, useStageStore } from '@/lib/store';

describe('stage edit mode', () => {
  beforeEach(() => {
    useStageStore.getState().clearStore();
    useCanvasStore.getState().resetCanvasState();
  });

  test('supports a global edit mode', () => {
    useStageStore.getState().setMode('edit');

    expect(useStageStore.getState().mode).toBe('edit');
  });

  test('clears canvas selection when leaving edit mode', () => {
    useStageStore.getState().setMode('edit');
    useCanvasStore.getState().setActiveElementIdList(['title']);
    useCanvasStore.getState().setEditingElementId('title');

    useStageStore.getState().setMode('playback');

    expect(useCanvasStore.getState().activeElementIdList).toEqual([]);
    expect(useCanvasStore.getState().handleElementId).toBe('');
    expect(useCanvasStore.getState().editingElementId).toBe('');
  });
});
