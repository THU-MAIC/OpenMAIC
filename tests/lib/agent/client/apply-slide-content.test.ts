/**
 * applyScenePatchInSync keeps the OPEN slide edit session in lockstep with the
 * stage store. When the patch carries new content for the scene the edit
 * session currently holds, it must reseed that session (else the canvas renders
 * stale history and the next edit clobbers the change). When the session points
 * at a different scene, it must NOT reseed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const updateScene = vi.fn();
const seed = vi.fn();
let sessionSceneId: string | null = null;

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: () => ({ updateScene }) },
}));

vi.mock('@/components/edit/surfaces/slide/slide-edit-session', () => ({
  useSlideEditSession: { getState: () => ({ sceneId: sessionSceneId, seed }) },
}));

import { applyScenePatchInSync } from '@/lib/agent/client/apply-slide-content';
import type { Scene, SlideContent } from '@/lib/types/stage';

const CONTENT = {
  type: 'slide',
  schemaVersion: 1,
  canvas: { id: 'cv', elements: [] },
} as unknown as SlideContent;

describe('applyScenePatchInSync', () => {
  beforeEach(() => {
    updateScene.mockClear();
    seed.mockClear();
    sessionSceneId = null;
  });

  it('always writes the patch through to the stage store', () => {
    const patch = { actions: [{ type: 'speech', id: 'a' }] } as unknown as Partial<Scene>;
    applyScenePatchInSync('s1', patch);
    expect(updateScene).toHaveBeenCalledWith('s1', patch);
  });

  it('reseeds the edit session when its sceneId matches the patched scene', () => {
    sessionSceneId = 's1';
    applyScenePatchInSync('s1', { content: CONTENT });
    expect(seed).toHaveBeenCalledWith('s1', CONTENT);
  });

  it('does NOT reseed when the edit session holds a different scene', () => {
    sessionSceneId = 's2';
    applyScenePatchInSync('s1', { content: CONTENT });
    expect(updateScene).toHaveBeenCalledWith('s1', { content: CONTENT });
    expect(seed).not.toHaveBeenCalled();
  });

  it('does NOT reseed when the patch carries no content (actions-only)', () => {
    sessionSceneId = 's1';
    applyScenePatchInSync('s1', { actions: [] } as unknown as Partial<Scene>);
    expect(seed).not.toHaveBeenCalled();
  });
});
