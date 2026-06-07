import { describe, expect, it } from 'vitest';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';

describe('isSceneEditLocked', () => {
  it('returns true only when edit mode owns the same scene', () => {
    expect(isSceneEditLocked({ sceneId: 'A', mode: 'edit', currentSceneId: 'A' })).toBe(true);
  });

  it('returns false when edit mode owns a different scene', () => {
    expect(isSceneEditLocked({ sceneId: 'A', mode: 'edit', currentSceneId: 'B' })).toBe(false);
  });

  it('returns false when not in edit mode', () => {
    expect(isSceneEditLocked({ sceneId: 'A', mode: 'playback', currentSceneId: 'A' })).toBe(false);
    expect(isSceneEditLocked({ sceneId: 'A', mode: 'autonomous', currentSceneId: 'A' })).toBe(
      false,
    );
  });

  it('returns false when there is no current scene', () => {
    expect(isSceneEditLocked({ sceneId: 'A', mode: 'edit', currentSceneId: null })).toBe(false);
  });
});
