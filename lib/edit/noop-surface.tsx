'use client';

import { useMemo } from 'react';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { useStageStore } from '@/lib/store/stage';
import type { Scene, SceneContent } from '@/lib/types/stage';
import type { SceneEditorSurface, SurfaceState } from './scene-editor-surface';

/**
 * NOOP_SURFACE — the read-only fallback surface used by the shell when no
 * editor surface is registered for the current `scene.type` (today:
 * interactive / pbl — slide and quiz have real surfaces). The shell resolves
 * `surface ?? NOOP_SURFACE`, so it always renders a single, structurally
 * stable `<Frame>` regardless of scene type. Switching to an unregistered
 * scene type therefore only swaps the
 * `surface.SurfaceComponent` inside the frame — `<CommandBar>` and the
 * `leftRail` slot stay mounted, eliminating the chrome remount flicker that
 * the previous two-component-types branch caused.
 *
 * The canvas is `SceneRenderer mode="playback"` — feature-parity with the
 * playback surface (interactive iframes load, quiz options render, PBL board
 * paints).
 *
 * `sceneType` is a placeholder ('slide'); NOOP_SURFACE is never `register()`d,
 * only used as a fallback from `resolve(...) ?? NOOP_SURFACE`. The field is
 * required by the surface contract but its value is never read in this path.
 */

function NoopCanvas() {
  const scenes = useStageStore.use.scenes();
  const currentSceneId = useStageStore.use.currentSceneId();
  const scene = useMemo<Scene | null>(
    () => scenes.find((s) => s.id === currentSceneId) ?? null,
    [scenes, currentSceneId],
  );

  if (!scene) return null;
  return <SceneRenderer scene={scene} mode="playback" />;
}

const EMPTY_STATE: SurfaceState<SceneContent, undefined> = {
  content: {} as SceneContent,
  selection: undefined,
  hasSelection: false,
  insertItems: [],
  floatingActions: [],
  commands: [],
  hints: [],
};

function useNoopSurfaceState(): SurfaceState<SceneContent, undefined> {
  // No state, no subscriptions — the chrome shows nothing surface-specific for
  // read-only scene types. Returning the module-level constant keeps the hook
  // signature minimal (zero internal hooks) and equality-stable across renders.
  return EMPTY_STATE;
}

export const NOOP_SURFACE: SceneEditorSurface<SceneContent, undefined> = {
  sceneType: 'slide',
  SurfaceComponent: NoopCanvas,
  useSurfaceState: useNoopSurfaceState,
};
