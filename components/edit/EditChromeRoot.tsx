'use client';

import { useEffect, useMemo } from 'react';
import { EditShell } from '@/components/edit/EditShell';
import { SlideNavRail } from '@/components/edit/SlideNavRail';
import { EditDock } from '@/components/edit/EditDock/EditDock';
import { HeaderControls } from '@/components/stage/header-controls';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { preloadEditor } from '@/lib/edit/preload-editor';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { getScenePagerState } from '@/lib/edit/scene-pager';
import { useStageStore } from '@/lib/store/stage';
import { useInWorkbenchPanel } from '@/lib/workbench/panel-context';
import { supportsNarrationTimeline } from './scene-timeline';
import type { Scene } from '@/lib/types/stage';

interface EditChromeRootProps {
  readonly scene: Scene;
  readonly isEditable: boolean;
  readonly onToggleEditMode?: () => void;
}

/**
 * Edit-mode root — wraps the Pro mode chrome assembly so `stage.tsx`
 * has a single component to mount in the edit branch instead of a
 * 13-line inline JSX with three children.
 *
 * Owned here: `EditShell` (Frame + CommandBar + canvas + overlays),
 * `SlideNavRail` (leftRail slot), the standalone-only `HeaderControls`
 * trailing that rides in CommandBar's right slot,
 * The legacy Edit-with-AI right rail has been retired: agentic edits live
 * exclusively in the Pro workspace conversation, and the classroom roster is
 * edited from a dialog opened off the edit dock's global bar.
 *
 * `scene` is required (non-null). The parent gates mounting on
 * `mode === 'edit' && currentScene` to satisfy this contract.
 */
export function EditChromeRoot({ scene, isEditable, onToggleEditMode }: EditChromeRootProps) {
  // Hosted inside the workbench panel? Then two pieces of chrome are
  // meaningless here: the Pro Switch (the panel is Pro-locked; there is
  // nowhere to toggle to) and the Edit-with-AI right rail (the workbench
  // conversation on the left is its successor — the agent it would talk to
  // is the one building this course).
  const inWorkbenchPanel = useInWorkbenchPanel();

  // Deck paging (‹ n/m ›). Same state source and setter the SlideNavRail
  // thumbnails use — `currentSceneId` / `setCurrentSceneId` — so flipping pages
  // from the dock and clicking a rail thumbnail can never disagree about which
  // page is open.
  const scenes = useStageStore.use.scenes();
  const currentSceneId = useStageStore.use.currentSceneId();
  const setCurrentSceneId = useStageStore.use.setCurrentSceneId();
  const pagerState = useMemo(
    () => getScenePagerState(scenes, currentSceneId),
    [scenes, currentSceneId],
  );
  const pager = pagerState
    ? {
        ...pagerState,
        onPrev: () => {
          if (pagerState.prevSceneId) setCurrentSceneId(pagerState.prevSceneId);
        },
        onNext: () => {
          if (pagerState.nextSceneId) setCurrentSceneId(pagerState.nextSceneId);
        },
      }
    : undefined;
  // Mark the body while edit mode is mounted, so the editor-scoped CSS
  // rule in globals.css that pins `body.padding-right` to 0 only fires
  // in Pro mode — not on non-editor pages where Radix's
  // react-remove-scroll compensation is still wanted. Lifted from
  // SlideCanvas (which was mounted only for slide scenes) so the
  // attribute now covers read-only scene types in Pro mode too.
  useEffect(() => {
    document.body.dataset.maicEditor = 'true';
    return () => {
      delete document.body.dataset.maicEditor;
    };
  }, []);

  // Safety net: the editor chunk (fonts + slide surface registration) is
  // normally preloaded by the Pro Switch handler in stage.tsx BEFORE mode
  // flips, so by the time we mount the surface is already registered and
  // EditShell resolves it immediately (no NOOP flash). This call is a
  // promise-cached no-op in that path; it only does real work if edit mode
  // is ever entered without going through the handler. Render is NOT gated
  // on it — the preload-before-flip contract keeps the chrome smooth.
  useEffect(() => {
    void preloadEditor();
  }, []);

  // Whether this scene type has a registered canvas editor surface (slide/quiz).
  // Authoring surface is separate from narration timeline availability.
  const authoringEnabled = !!sceneEditorRegistry.resolve(scene.type);
  // The narration timeline is decoupled from the canvas editor surface (like
  // agentEnabled below): it applies to registered surfaces (slide/quiz) AND
  // view-only canvases that still carry a spoken script (interactive/pbl). It is
  // also the dock's gate: the timeline is the dock's first tool, so where there
  // is no timeline there is no bench to hang other tools off either.
  const timelineEnabled = supportsNarrationTimeline(scene.type, authoringEnabled);

  const headerControls = inWorkbenchPanel ? undefined : (
    <HeaderControls
      mode="edit"
      canEdit={isEditable}
      onToggleEditMode={isMaicEditorEnabled() && !inWorkbenchPanel ? onToggleEditMode : undefined}
    />
  );

  return (
    <EditShell
      scene={scene}
      leftRail={<SlideNavRail />}
      bottomRail={
        timelineEnabled ? (
          <EditDock sceneId={scene.id} sceneType={scene.type} pager={pager} />
        ) : undefined
      }
      commandTrailing={headerControls}
      // The pager normally lives in the dock's global edit bar (handed to `EditDock`
      // above). Only a scene type that gets no dock at all keeps the floating
      // form — otherwise those scenes would lose paging entirely.
      pager={timelineEnabled ? undefined : pager}
      hideCommandBar={inWorkbenchPanel}
    />
  );
}
