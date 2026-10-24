'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { useStageStore, useCanvasStore } from '@/lib/store';
import {
  isCurrentSceneEditable,
  isHostedSceneEditable,
  resolveStageChromeMode,
} from '@/lib/edit/stage-mode';
import { isMaicEditorEnabled, isWorkbenchEnabled } from '@/lib/config/feature-flags';
import { EditChromeRoot } from '@/components/edit/EditChromeRoot';
import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';
import {
  InteractiveIframeHost,
  type PlaybackInteractiveComponentPick,
  type PlaybackInteractivePickerState,
} from '@/components/scene-renderers/InteractiveIframeHost';
import { CHROME_EASE } from '@/lib/edit/transitions';
import { enterEditMode } from '@/lib/edit/enter-edit-mode';
import { isEditorPreloaded, preloadEditor } from '@/lib/edit/preload-editor';
import { WorkbenchReturnControl } from '@/components/workbench/WorkbenchReturnControl';
import { resolveClassroomBackControl } from '@/lib/workbench/classroom-back-control';
import { resolveClassroomHeaderControls } from '@/lib/workbench/classroom-header-controls';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useWorkbenchPanelState } from '@/lib/workbench/panel-context';
import { workspaceHref } from '@/lib/workbench/workspace-panes';

/**
 * Stage — top-level classroom container. Standalone classrooms dispatch
 * between the two chrome roots based on `useStageStore.mode`:
 *
 *   mode === 'edit'                → EditChromeRoot
 *   mode === 'playback' / 'autonomous' → PlaybackChromeRoot
 *
 * A hosted classroom takes its learning/editing intent from the pane. The
 * pane applies the course preference and access gates, and this component
 * additionally enforces the live generation fence. This remains view state;
 * the published/persisted StageMode contract does not change.
 *
 * The host itself owns the three-pane layout, the conversation, the session
 * stream and the course sync. Stage's only responsibilities are: mode
 * dispatch and Pro Switch toggle wiring (calls into
 * PlaybackChromeRoot.teardown via ref before flipping mode).
 */
export function Stage({
  classroomId,
  onRetryOutline,
  generationFailureMessage,
}: {
  classroomId?: string;
  onRetryOutline?: (outlineId: string) => Promise<void>;
  generationFailureMessage?: string;
}) {
  const { mode, setMode, scenes, currentSceneId, generatingOutlines, stage } = useStageStore();
  const router = useRouter();
  const enteringWorkbench = useRef(false);
  const proWorkbenchFlag = isWorkbenchEnabled();
  const editorEnabled = isMaicEditorEnabled();
  const [proRuntime, setProRuntime] = useState<'pending' | 'on' | 'off'>(
    proWorkbenchFlag ? 'pending' : 'off',
  );
  useEffect(() => {
    if (!proWorkbenchFlag) return;
    let cancelled = false;
    fetch('/api/agent/runtime')
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled) setProRuntime(body?.enabled === true ? 'on' : 'off');
      })
      .catch(() => {
        if (!cancelled) setProRuntime('off');
      });
    return () => {
      cancelled = true;
    };
  }, [proWorkbenchFlag]);
  const proWorkbenchEntry = proWorkbenchFlag && proRuntime === 'on';
  const currentScene = useStageStore((s) => s.getCurrentScene());
  // The reference implementation makes editing owner-only. `isOwner` is true for the stage creator,
  // so this gate hides Pro mode from visitors / bookmarked viewers — their saves
  // would not pass the owner check anyway.
  const isOwner = useStageStore((s) => s.isOwner);
  const readOnly = useStageStore((s) => s.readOnly);
  // A course its generation run is still producing is read-only until the run
  // completes (the server refuses its edits): the Pro switch shows, disabled,
  // as it does while the browser generates.
  const courseGenerating = useStageStore((s) => s.courseGenerating);
  const canEditOwnedStage = isOwner && !readOnly;

  // Hosted by the Pro workspace's classroom pane. Ambient rather than a prop
  // because `Stage` is built by `ClassroomSurface`, which is mounted by both
  // the route and the pane and has no business knowing which.
  //
  // The provider is the host boundary. Session state intentionally does not
  // participate: it outlives route transitions and previously made an ordinary
  // classroom inherit the workspace's edit chrome after SPA navigation.
  const workbenchPanel = useWorkbenchPanelState();
  const inWorkspacePane = workbenchPanel.hosted;
  const hosted = proWorkbenchFlag && inWorkspacePane;
  // Pane view state comes from the pane boundary, not from the attached-chat
  // fold. `attach()` intentionally rebuilds that fold when Chat changes; using
  // its panelOpen bit here made the keyed edit/playback roots swap for one
  // frame and produced a full classroom flash.
  const workbenchPlayback = workbenchPanel.playback;
  // The host's edit intent is independent of full-screen playback and chat.
  const workbenchShowingClassroom = hosted && workbenchPanel.editPinned;

  // Single decision for the classroom chrome's top-left back affordance:
  // plain classroom → home arrow; full-screen playback → "Back to workspace";
  // every other hosted form (the workspace pane) → hidden (the conversation
  // and the navigation tree are already beside the classroom, and a home
  // arrow would exit the workspace). See lib/workbench/classroom-back-control.ts.
  const classroomBackControl = resolveClassroomBackControl(hosted, workbenchPlayback);
  const classroomHeaderControls = resolveClassroomHeaderControls(hosted, workbenchPlayback);

  // Predicate for "can the user enter Pro mode for the current scene?".
  // Single source of truth feeds the Header's Pro Switch state and the
  // auto-exit effect below; keeping them in lock-step prevents an
  // edit-mode entry that would immediately auto-exit.
  const isEditable =
    canEditOwnedStage &&
    !courseGenerating &&
    isCurrentSceneEditable({
      currentSceneId,
      sceneCount: scenes.length,
      generatingOutlineCount: generatingOutlines.length,
      hasCurrentScene: !!currentScene,
    });

  // Hosted agent edits are page-scoped; a server generation run still locks
  // the whole course through courseGenerating below.
  const currentStageMatchesHost = !classroomId || stage?.id === classroomId;
  const hostedSceneEditable = isHostedSceneEditable({
    editorEnabled,
    isOwner: canEditOwnedStage && !courseGenerating,
    stageMatchesHost: currentStageMatchesHost,
    currentSceneId,
    sceneCount: scenes.length,
    generatingOutlineCount: generatingOutlines.length,
    hasCurrentScene: !!currentScene,
  });
  const chromeEditable = hosted ? hostedSceneEditable : isEditable;
  // Only an already mounted learning surface stays up during edit entry.
  // Cold editing mounts and reopened editors wait in the neutral loading shell.
  const [editorPreloadState, setEditorPreloadState] = useState<
    'idle' | 'loading' | 'playback' | 'ready' | 'failed'
  >(() => (isEditorPreloaded() ? 'ready' : 'idle'));
  const playbackRef = useRef<PlaybackChromeRootHandle>(null);

  useEffect(() => {
    const mountedPlayback = playbackRef.current;
    if (!hosted || !workbenchShowingClassroom || !hostedSceneEditable) {
      setEditorPreloadState(
        hosted && workbenchPanel.visible && currentStageMatchesHost && mountedPlayback
          ? 'playback'
          : 'idle',
      );
      return;
    }
    if (!mountedPlayback && isEditorPreloaded()) {
      setEditorPreloadState('ready');
      return;
    }
    let cancelled = false;
    setEditorPreloadState((previous) =>
      mountedPlayback && previous === 'playback' ? 'playback' : 'loading',
    );
    void enterEditMode({
      teardown: () => mountedPlayback?.teardown(),
      preload: preloadEditor,
      activate: () => {
        if (!cancelled) setEditorPreloadState('ready');
      },
      onError: (error) => {
        console.error('[Stage] hosted editor entry failed', error);
        if (!cancelled) {
          setEditorPreloadState((previous) => (previous === 'playback' ? 'playback' : 'failed'));
        }
      },
    });
    return () => {
      cancelled = true;
    };
  }, [
    hosted,
    workbenchShowingClassroom,
    hostedSceneEditable,
    classroomId,
    workbenchPanel.visible,
    currentStageMatchesHost,
  ]);

  // Resolve before paint so a restored edit preference cannot override a
  // generating course's fence or leak into a different course's chrome.
  const chromeMode = resolveStageChromeMode({
    storedMode: mode,
    hosted,
    workbenchShowingClassroom,
    workbenchLearning:
      hosted &&
      workbenchPanel.visible &&
      (workbenchPanel.learning ||
        courseGenerating ||
        (workbenchShowingClassroom && editorPreloadState === 'playback')),
    isEditable: chromeEditable,
    hasCurrentScene: !!currentScene,
    stageMatchesHost: currentStageMatchesHost,
    editorReady: editorPreloadState === 'ready',
    editorLoadFailed: editorPreloadState === 'failed',
  });

  useEffect(() => {
    if (!hosted || chromeMode !== 'edit') return;
    return () => useCanvasStore.getState().resetCanvasState();
  }, [hosted, chromeMode]);

  const [playbackInteractivePicker, setPlaybackInteractivePicker] =
    useState<PlaybackInteractivePickerState | null>(null);
  const handlePlaybackInteractivePick = useCallback((pick: PlaybackInteractiveComponentPick) => {
    playbackRef.current?.acceptInteractivePick(pick);
  }, []);
  const handlePlaybackInteractiveCancel = useCallback(() => {
    playbackRef.current?.cancelElementPick();
  }, []);

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

  // Non-owners and transport-fenced owners get no Pro toggle at all: without a
  // handler the Header/CommandBar omit the whole switch. Editable owners keep
  // it while a scene is still generating (rendered disabled), matching upstream.
  const toggleHandler = editorEnabled && canEditOwnedStage ? handleToggleEditMode : undefined;
  const setPanelOpen = useWorkbenchStore((s) => s.setPanelOpen);

  /**
   * In the reference implementation, Pro Mode on a regular classroom is the workspace, not the old
   * right-rail editor. The conversation on the left is where further instructions
   * go; the classroom stays on the right.
   *
   * It opens the course and NOTHING else. Minting a conversation here created one
   * empty session per Pro-mode entry — leave and come back three times, three rows
   * in the rail — and named each one after the classroom, which said the two were
   * one object. The workspace decides what the middle column holds (the user's most
   * recent conversation, or an empty composer whose first message creates one), so
   * this is now a plain navigation with no request behind it.
   */
  const handleEnterWorkbench = useCallback(() => {
    if (!stage?.id || enteringWorkbench.current) return;
    enteringWorkbench.current = true;
    try {
      setPanelOpen(true, true);
      router.replace(workspaceHref({ sessionId: null, courseId: stage.id }));
    } finally {
      enteringWorkbench.current = false;
    }
  }, [router, setPanelOpen, stage?.id]);

  // A classroom hosted by the workspace has no edit control of its own: the
  // pane's learning/editing switch lives in its tab header, and full-screen
  // learning returns through `WorkbenchReturnControl`. On the classroom route
  // the control opens the course in the workspace where one is available, and
  // toggles this page's own editor otherwise.
  const chromeToggleHandler = hosted
    ? undefined
    : !isOwner || proRuntime === 'pending'
      ? undefined
      : proWorkbenchEntry
        ? handleEnterWorkbench
        : toggleHandler;

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
  //
  // The classroom itself is built once and mounted either full-bleed (the
  // route) or inside the workspace's classroom pane: there is exactly one of
  // these expressions in the app, so "the pane IS the classroom" is
  // structural rather than aspirational.
  const classroomChrome = (
    <AnimatePresence initial={false}>
      {/* The dispatch is exhaustive on `chromeMode` on purpose. The learning
          chrome is reached ONLY by an explicit playback resolution, so it can
          no longer be inherited as the else-branch of a condition about
          something else — a resolved `edit` with no scene to hand shows the
          neutral shell and waits, exactly as `loading` does. */}
      {chromeMode === 'edit' && currentScene ? (
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
            isEditable={chromeEditable}
            onToggleEditMode={chromeToggleHandler}
          />
        </motion.div>
      ) : chromeMode === 'playback' || chromeMode === 'autonomous' ? (
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
            onInteractivePickerChange={setPlaybackInteractivePicker}
            onRetryOutline={onRetryOutline}
            generationFailureMessage={generationFailureMessage}
            canEnterProMode={isEditable}
            onEnterProMode={chromeToggleHandler}
            editOpensWorkspace={!hosted && proWorkbenchEntry}
            headerBackControl={
              classroomBackControl === 'workbench-return' ? <WorkbenchReturnControl /> : undefined
            }
            hideHeaderBackControl={classroomBackControl === 'hidden'}
            hideHeader={!classroomHeaderControls.showHeader}
            hideHeaderGlobalControls={!classroomHeaderControls.showGlobalControls}
            hideHeaderCourseActions={!classroomHeaderControls.showCourseActions}
          />
        </motion.div>
      ) : (
        <div
          key="loading"
          data-testid="stage-editor-loading"
          className="absolute inset-0 flex bg-background"
          aria-busy="true"
        />
      )}
    </AnimatePresence>
  );

  return (
    <div className="relative flex flex-1 overflow-hidden">
      {/* The edit-mode guard has been removed (#1961 decision change 2026-08-23): a
          new agent version directly replaces the canvas; the user's typed data is
          protected by the write-path veto/retry channel (see lib/store/stage.ts),
          and there is no longer an "agent modified this page" banner or a manual
          reload entry. */}
      {classroomChrome}
      {/* Full-screen playback steps the workspace aside; the return to the
          conversation lives in the classroom header's left slot (passed as
          `headerBackControl` above), so it never floats over the courseware.
          The fold and pane state live in the store, so the return restores
          them exactly. */}
      {/* Keep-alive host for interactive scene iframes (#619). Lives here, above
          the mode-swap subtree, so its iframes survive Pro mode toggles and
          scene switches instead of reloading on every remount. */}
      <InteractiveIframeHost
        playbackPicker={playbackInteractivePicker}
        onPlaybackPick={handlePlaybackInteractivePick}
        onPlaybackCancel={handlePlaybackInteractiveCancel}
      />
    </div>
  );
}
