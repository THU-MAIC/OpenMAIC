'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { useStageStore } from '@/lib/store';
import {
  isCurrentSceneEditable,
  isHostedSceneEditable,
  resolveStageChromeMode,
} from '@/lib/edit/stage-mode';
import { isMaicEditorEnabled, isProWorkbenchEnabled } from '@/lib/config/feature-flags';
import { EditChromeRoot } from '@/components/edit/EditChromeRoot';
import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';
import { CHROME_EASE } from '@/lib/edit/transitions';
import { enterEditMode } from '@/lib/edit/enter-edit-mode';
import { isEditorPreloaded, preloadEditor } from '@/lib/edit/preload-editor';
import { WorkbenchReturnControl } from '@/components/workbench/WorkbenchReturnControl';
import { resolveClassroomBackControl } from '@/lib/workbench/classroom-back-control';
import { resolveClassroomHeaderControls } from '@/lib/workbench/classroom-header-controls';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useWorkbenchPanelState } from '@/lib/workbench/panel-context';
import { workspaceHref } from '@/lib/workbench/workspace-panes';
import { exitProPlaybackToStandalone } from '@/lib/workbench/pro-playback-exit';

/**
 * Stage — top-level classroom container. Standalone classrooms dispatch
 * between the two chrome roots based on `useStageStore.mode`:
 *
 *   mode === 'edit'                → EditChromeRoot
 *   mode === 'playback' / 'autonomous' → PlaybackChromeRoot
 *
 * When this classroom is HOSTED — mounted inside the Pro workspace's classroom
 * pane rather than filling a route — the dispatch below is not replaced, it is
 * merely stripped of the chrome that the host already provides: no header, no
 * global controls or Pro switch (the pane IS Pro-locked). Hosted chrome is
 * EDIT-LOCKED: the pane declares the lock once (`WorkbenchPanelState.editPinned`)
 * and this component reads it back, so no entry path — a course the agent just
 * created, a restored tab, a tab switch, a reload — gets to decide otherwise.
 * The learning chrome is reachable only through Start Learning, which clears
 * the lock at the pane. Everything else resolves synchronously between the
 * neutral loading shell and edit, so a hosted first paint can never be
 * playback. Deliberately not a third
 * `StageMode` — `StageMode` lives in the
 * published `@openmaic/dsl` and is persisted with the stage, whereas "this is
 * rendered inside the workspace right now" is view state that must not outlive
 * the tab.
 *
 * The host itself owns the three-pane layout, the conversation, the session
 * stream and the course sync. Stage's only responsibilities are: mode
 * dispatch and Pro Switch toggle wiring (calls into
 * PlaybackChromeRoot.teardown via ref before flipping mode).
 */
export function Stage({
  classroomId,
  onRetryOutline,
}: {
  classroomId?: string;
  onRetryOutline?: (outlineId: string) => Promise<void>;
}) {
  const { mode, setMode, scenes, currentSceneId, generatingOutlines, stage } = useStageStore();
  const router = useRouter();
  const enteringWorkbench = useRef(false);
  const proWorkbenchFlag = isProWorkbenchEnabled();
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
  // The reference implementation makes editing owner-only. `isOwner` is true for the stage creator and
  // defaults to true with browser storage (single-user IndexedDB), so this gate is
  // a no-op upstream but hides Pro mode from visitors / bookmarked viewers in
  // server-backed mode — their saves would not pass the owner check anyway.
  const isOwner = useStageStore((s) => s.isOwner);
  const readOnly = useStageStore((s) => s.readOnly);
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
  // The classroom is showing exactly when it is hosted and the pane says it is
  // edit-locked. The lock is computed once, at the provider the workspace
  // mounts the classroom through (`WorkbenchPanelProvider`), so this is the
  // pane's answer being read back rather than a second derivation that could
  // disagree with it.
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
    isCurrentSceneEditable({
      currentSceneId,
      sceneCount: scenes.length,
      generatingOutlineCount: generatingOutlines.length,
      hasCurrentScene: !!currentScene,
    });

  // Hosted generation is page-granular: once the current page materialises,
  // the human may edit it while the agent writes later scene IDs. Keep the
  // stricter whole-deck generation gate above for standalone Pro mode.
  const currentStageMatchesHost = !classroomId || stage?.id === classroomId;
  const hostedSceneEditable = isHostedSceneEditable({
    editorEnabled,
    isOwner: canEditOwnedStage,
    stageMatchesHost: currentStageMatchesHost,
    currentSceneId,
    sceneCount: scenes.length,
    generatingOutlineCount: generatingOutlines.length,
    hasCurrentScene: !!currentScene,
  });
  const chromeEditable = hosted ? hostedSceneEditable : isEditable;
  // Seeded from the module-level registry rather than always starting at
  // `idle`: once the editor chunk has been imported in this tab, a remount
  // (course switch, reopened tab) must resolve to the edit chrome during the
  // FIRST render. Starting at `idle` would spend a paint on the neutral
  // loading shell waiting for an import that already finished.
  const [editorPreloadState, setEditorPreloadState] = useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >(() => (isEditorPreloaded() ? 'ready' : 'idle'));

  useEffect(() => {
    if (!hosted || !workbenchShowingClassroom || !hostedSceneEditable) return;
    // Already registered — do not knock the state back to `loading`, which
    // would blank an edit chrome that is on screen and correct.
    if (isEditorPreloaded()) {
      setEditorPreloadState('ready');
      return;
    }
    let cancelled = false;
    setEditorPreloadState('loading');
    preloadEditor()
      .then(() => {
        if (!cancelled) setEditorPreloadState('ready');
      })
      .catch((error) => {
        console.error('[Stage] hosted editor preload failed', error);
        if (!cancelled) setEditorPreloadState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [hosted, workbenchShowingClassroom, hostedSceneEditable]);

  // The workspace owns the edit/playback intent: the pane's edit lock is the
  // edit intent, while Start Learning (`workbenchPlayback`) is the one signal
  // that releases it. Resolve that intent in render rather than mutating the
  // transient stage-store mode in an effect — otherwise every hosted course
  // paints PlaybackChromeRoot once before the effect can run, and a course
  // switch can inherit stale mode.
  const chromeMode = resolveStageChromeMode({
    storedMode: mode,
    hosted,
    workbenchShowingClassroom,
    workbenchLearning: hosted && workbenchPlayback,
    isEditable: chromeEditable,
    hasCurrentScene: !!currentScene,
    stageMatchesHost: currentStageMatchesHost,
    editorReady: editorPreloadState === 'ready',
    editorLoadFailed: editorPreloadState === 'failed',
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

  const handleExitWorkbench = useCallback(async () => {
    if (!stage?.id) return;
    await exitProPlaybackToStandalone({
      stageId: stage.id,
      teardown: () => playbackRef.current?.teardown(),
      // Hosted playback is view state and may be masking a stale standalone
      // `edit` mode. Commit playback before leaving the workspace so the
      // ordinary classroom stays on the exact learning surface the user saw.
      setMode,
      replace: (href) => router.replace(href),
      onTeardownError: (error) => console.error('[Stage] workbench exit teardown failed', error),
    });
  }, [router, setMode, stage?.id]);

  // The embedded pane is already Pro-locked, so it has no switch. Full-screen
  // learning exposes an active switch whose off transition exits the workspace
  // and returns to the ordinary classroom route.
  const chromeToggleHandler = hosted
    ? workbenchPlayback
      ? handleExitWorkbench
      : undefined
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
            onRetryOutline={onRetryOutline}
            canEnterProMode={workbenchPlayback || isEditable}
            onEnterProMode={chromeToggleHandler}
            proModeActive={hosted && workbenchPlayback}
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
      <InteractiveIframeHost />
    </div>
  );
}
