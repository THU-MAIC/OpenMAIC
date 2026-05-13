import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useCanvasStore, useStageStore } from '@/lib/store';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { isCurrentSceneEditable } from '@/lib/edit/stage-mode';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import type { SceneType } from '@/lib/types/stage';

describe('stage edit mode store', () => {
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

describe('isCurrentSceneEditable', () => {
  test('returns true when a real scene is resolved and nothing is generating', () => {
    expect(
      isCurrentSceneEditable({
        currentSceneId: 'scene-1',
        sceneCount: 3,
        generatingOutlineCount: 0,
        hasCurrentScene: true,
      }),
    ).toBe(true);
  });

  test('returns false on the pending placeholder scene', () => {
    expect(
      isCurrentSceneEditable({
        currentSceneId: PENDING_SCENE_ID,
        sceneCount: 3,
        generatingOutlineCount: 0,
        hasCurrentScene: true,
      }),
    ).toBe(false);
  });

  test('returns false when no scenes have materialised yet', () => {
    expect(
      isCurrentSceneEditable({
        currentSceneId: null,
        sceneCount: 0,
        generatingOutlineCount: 0,
        hasCurrentScene: false,
      }),
    ).toBe(false);
  });

  test('returns false while outline generation is still in flight', () => {
    expect(
      isCurrentSceneEditable({
        currentSceneId: 'scene-1',
        sceneCount: 1,
        generatingOutlineCount: 2,
        hasCurrentScene: true,
      }),
    ).toBe(false);
  });

  test('returns false when current scene id does not resolve to a scene', () => {
    expect(
      isCurrentSceneEditable({
        currentSceneId: 'scene-x',
        sceneCount: 3,
        generatingOutlineCount: 0,
        hasCurrentScene: false,
      }),
    ).toBe(false);
  });
});

describe('sceneEditorRegistry', () => {
  function makeSurface(sceneType: SceneType, label = 'A'): SceneEditorSurface {
    return {
      sceneType,
      CanvasComponent: () => null,
      useSurfaceState: () => ({
        // Cast through unknown because tests don't need a real surface state;
        // we only exercise the registry contract here.
        content: { type: sceneType, label } as unknown as never,
        selection: null,
        hasSelection: false,
        history: { canUndo: false, canRedo: false, undo: () => {}, redo: () => {} },
        insertItems: [],
        floatingActions: [],
        commands: [],
      }),
    };
  }

  afterEach(() => {
    sceneEditorRegistry.unregister('slide');
    sceneEditorRegistry.unregister('quiz');
  });

  test('register and resolve round-trip by sceneType', () => {
    const surface = makeSurface('slide');
    sceneEditorRegistry.register(surface);
    expect(sceneEditorRegistry.resolve('slide')).toBe(surface);
  });

  test('resolve returns undefined for unregistered sceneType', () => {
    expect(sceneEditorRegistry.resolve('pbl')).toBeUndefined();
  });

  test('re-registering the identical surface instance does not warn (HMR-safe)', () => {
    const surface = makeSurface('slide');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    sceneEditorRegistry.register(surface);
    sceneEditorRegistry.register(surface);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('registering a different surface for the same sceneType warns in dev', () => {
    const first = makeSurface('slide', 'A');
    const second = makeSurface('slide', 'B');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    sceneEditorRegistry.register(first);
    sceneEditorRegistry.register(second);

    expect(warn).toHaveBeenCalledOnce();
    expect(sceneEditorRegistry.resolve('slide')).toBe(second);
    warn.mockRestore();
  });

  test('unregister removes the surface', () => {
    const surface = makeSurface('quiz');
    sceneEditorRegistry.register(surface);
    expect(sceneEditorRegistry.resolve('quiz')).toBe(surface);

    sceneEditorRegistry.unregister('quiz');
    expect(sceneEditorRegistry.resolve('quiz')).toBeUndefined();
  });
});
