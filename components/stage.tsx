'use client';

import { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useStageStore } from '@/lib/store';
import { isCurrentSceneEditable } from '@/lib/edit/stage-mode';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { EditChromeRoot } from '@/components/edit/EditChromeRoot';
import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';
import { CHROME_EASE } from '@/lib/edit/transitions';
import { enterEditMode } from '@/lib/edit/enter-edit-mode';
import { preloadEditor } from '@/lib/edit/preload-editor';

/**
 * Stage — top-level classroom container. Dispatches between the two
 * chrome roots based on `useStageStore.mode`:
 *
 *   mode === 'edit'                → EditChromeRoot
 *   mode === 'playback' / 'autonomous' → PlaybackChromeRoot
 *
 * The two roots are wholly independent. Stage's only responsibilities
 * are: mode dispatch and Pro Switch toggle wiring (calls into
 * PlaybackChromeRoot.teardown via ref before flipping mode).
 */
export function Stage({
  onRetryOutline,
}: {
  onRetryOutline?: (outlineId: string) => Promise<void>;
}) {
  const { mode, setMode, scenes, currentSceneId, generatingOutlines } = useStageStore();
  const currentScene = useStageStore((s) => s.getCurrentScene());
  // Editing is owner-only (the reference's classroom access fields). `isOwner`
  // is true and `readOnly` is false by default — the upstream single-user
  // assumption — so this gate is a no-op unless the stage-meta sidecar
  // answered that the viewer is not this course's owner.
  const isOwner = useStageStore((s) => s.isOwner);
  const readOnly = useStageStore((s) => s.readOnly);
  const canEditOwnedStage = isOwner && !readOnly;

  // Predicate for "can the user enter Pro mode for the current scene?".
  // Single source of truth feeds the Header's Pro Switch state and the
  // auto-exit effect below; keeping them in lock-step prevents an
  // edit-mode entry that would immediately auto-exit.
  const isEditable =
    canEditOwnedStage &&
    isCurrentSceneEditable({
      currentSceneId,
      sceneCount: scenes.length,
      generatingOutlineCount: generatingOutlines.length,
      hasCurrentScene: !!currentScene,
    });

  const playbackRef = useRef<PlaybackChromeRootHandle>(null);

  // Pro Switch handler. Edit→playback is a plain flip (PlaybackChromeRoot
  // will mount fresh; its engine effect re-inits). Playback→edit must
  // await SSE / engine / TTS teardown so PlaybackChromeRoot is quiescent
  // before it unmounts.
  const handleToggleEditMode = useCallback(async () => {
    if (mode === 'edit') {
      setMode('playback');
      return;
    }
    // Load the editor chunk (fonts + slide surface) BEFORE flipping mode,
    // so the edit chrome animates in with its content already present and
    // the slide surface registered — no mid-animation pop-in / NOOP flash.
    // Runs concurrently with teardown; the import is promise-cached so it's
    // a no-op on subsequent toggles.
    await enterEditMode({
      teardown: () => playbackRef.current?.teardown(),
      preload: preloadEditor,
      activate: () => setMode('edit'),
      // Stay in playback so the failure surfaces rather than half-entering
      // edit mode.
      onError: (error) => console.error('[Stage] Pro mode entry failed during teardown', error),
    });
  }, [mode, setMode]);

  // Auto-exit edit mode when the current scene becomes uneditable
  // (pending generation, no scenes, currently generating).
  useEffect(() => {
    if (mode === 'edit' && !isEditable) {
      setMode('playback');
    }
  }, [mode, isEditable, setMode]);

  const toggleHandler = isMaicEditorEnabled() ? handleToggleEditMode : undefined;

  // Mode swap choreography — a clean opacity cross-fade. Both roots layer
  // via `absolute inset-0` so they coexist for the ~280ms window without
  // one popping out before the other arrives. The outgoing root keeps
  // rendering its canvas during exit so `canvasStore` (the shared scale
  // writer) doesn't briefly read zero.
  //
  // Deliberately NO transform (translateY) on these layers: the edit
  // chrome hosts the Pro Switch / settings pill, which morph across the
  // swap via `layoutId`. A transform on this ancestor distorts motion's
  // layout measurement (the pill visibly drifts) and the blurred chrome
  // would repaint its backdrop-filter every frame while translating. A
  // pure fade keeps layout static so the shared elements land precisely.
  return (
    <div className="relative flex flex-1 overflow-hidden">
      <AnimatePresence initial={false}>
        {mode === 'edit' && currentScene ? (
          <motion.div
            key="edit"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: CHROME_EASE }}
            className="absolute inset-0 flex"
          >
            <EditChromeRoot
              scene={currentScene}
              isEditable={isEditable}
              onToggleEditMode={toggleHandler}
            />
          </motion.div>
        ) : (
          <motion.div
            key="playback"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: CHROME_EASE }}
            className="absolute inset-0 flex"
          >
            <PlaybackChromeRoot
              ref={playbackRef}
              onRetryOutline={onRetryOutline}
              canEnterProMode={isEditable}
              onEnterProMode={toggleHandler}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {/* Keep-alive host for interactive scene iframes (#619). Lives here, above
          the mode-swap subtree, so its iframes survive Pro mode toggles and
          scene switches instead of reloading on every remount. */}
      <InteractiveIframeHost />
    </div>
  );
}
