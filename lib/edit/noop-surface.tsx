'use client';

import { Eye } from 'lucide-react';
import { useMemo } from 'react';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type { Scene, SceneContent } from '@/lib/types/stage';
import type { SceneEditorSurface, SurfaceState } from './scene-editor-surface';

/**
 * NOOP_SURFACE — the read-only fallback surface used by the shell when no
 * editor surface is registered for the current `scene.type` (today: quiz /
 * interactive / pbl). The shell resolves `surface ?? NOOP_SURFACE`, so it
 * always renders a single, structurally stable `<Frame>` regardless of scene
 * type. Switching from a slide to a non-slide scene therefore only swaps the
 * `surface.CanvasComponent` inside the frame — `<CommandBar>` and the
 * `leftRail` slot stay mounted, eliminating the chrome remount flicker that
 * the previous two-component-types branch caused.
 *
 * The canvas is `SceneRenderer mode="playback"` — feature-parity with the
 * playback surface (interactive iframes load, quiz options render, PBL board
 * paints) — plus a small "read-only" pill so the user knows why their
 * formatting affordances are gone.
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
  return (
    <>
      <SceneRenderer scene={scene} mode="playback" />
      <ReadOnlyBadge sceneType={scene.type} />
    </>
  );
}

function ReadOnlyBadge({ sceneType }: { readonly sceneType: Scene['type'] }) {
  const { t } = useI18n();
  return (
    <div className="pointer-events-none absolute top-4 left-1/2 z-20 -translate-x-1/2">
      <div className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-zinc-900/85 px-3 py-1 text-[11px] font-medium text-white shadow-md backdrop-blur-sm dark:bg-white/90 dark:text-zinc-900">
        <Eye className="h-3 w-3" strokeWidth={2.5} />
        <span>{t('edit.readOnlyBadge', { type: t(`edit.sceneType.${sceneType}`) })}</span>
      </div>
    </div>
  );
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
  CanvasComponent: NoopCanvas,
  useSurfaceState: useNoopSurfaceState,
};
