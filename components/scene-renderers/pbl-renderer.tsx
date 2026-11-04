'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PBLContent, StageMode } from '@/lib/types/stage';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { resolvePBLContent, upgradeLegacyPBLConfigToProjectV2 } from '@/lib/pbl/legacy/read';
import { normalizeProjectRuntime } from '@/lib/pbl/v2/operations/kernel/progress';
import { transitionProjectUiPhase } from '@/lib/pbl/v2/operations/kernel/runtime-events';
import { useStageStore } from '@/lib/store/stage';
import { PBLV2Hero } from './pbl/v2/hero';
import { PBLV2Workspace } from './pbl/v2/workspace';
import { PBLV2Completion } from './pbl/v2/completion';
import { PBLV3Container } from './pbl/v3/project-entry';
import { PBLWorkspaceLayer } from './pbl/workspace-layer';
import { useI18n } from '@/lib/hooks/use-i18n';

interface PBLRendererProps {
  readonly content: PBLContent;
  readonly mode: StageMode;
  readonly sceneId: string;
}

export function PBLRenderer({ content, mode: _mode, sceneId }: PBLRendererProps) {
  const { t } = useI18n();

  const resolvedProjectV2 = useMemo(() => {
    // null is treated like absent: stored scenes predating projectV2 validation
    // may carry an explicit null and must keep falling back to the legacy path.
    const resolved = resolvePBLContent(content);
    if (resolved.kind === 'v2') return resolved.projectV2;
    if (resolved.kind === 'legacy') {
      return upgradeLegacyPBLConfigToProjectV2(resolved.projectConfig);
    }
    return null;
  }, [content]);

  if (content.projectV3) return <PBLV3Container key={sceneId} sceneId={sceneId} />;

  if (resolvedProjectV2) {
    return (
      <PBLV2Container
        sceneId={sceneId}
        projectV2={resolvedProjectV2}
        onProjectV2Change={(next) => {
          useStageStore.getState().updateScene(sceneId, {
            content: {
              ...content,
              projectV2: next,
            },
          });
        }}
      />
    );
  }

  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <p>{t('pbl.emptyProject')}</p>
    </div>
  );
}

function PBLV2Container({
  sceneId,
  projectV2,
  onProjectV2Change,
}: {
  readonly sceneId: string;
  readonly projectV2: PBLProjectV2;
  readonly onProjectV2Change: (next: PBLProjectV2) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Web-fullscreen ("expanded") vs docked. The workspace renders as a
  // SINGLE persistent instance for the whole workspace phase — expand /
  // collapse only animates its frame's rect, it never remounts. That is
  // what keeps the chat's scroll position and any in-flight Instructor
  // stream alive across the toggle (a remount would reset the scroll and
  // drop the "thinking…" indicator).
  const [expanded, setExpanded] = useState(false);
  // One-shot request from the Hero to auto-expand on first launch. The
  // layer consumes it on mount so a later return to the workspace (e.g.
  // from Completion) stays docked instead of re-expanding.
  const [autoExpand, setAutoExpand] = useState(false);
  // The web-fullscreen frame is portaled OUT of the scene subtree. It must
  // live inside whatever element is natively fullscreened — OpenMAIC fullscreens
  // the stage via stageRef.requestFullscreen(), and the browser only paints the
  // fullscreened element's own subtree, so a frame portaled to <body> would go
  // blank during native fullscreen. Default to <body> (classroom is an
  // immersive, full-viewport route, so a fixed overlay there already covers
  // everything); follow the active fullscreen element while native fullscreen
  // is on. NOTE: this never reads/writes OpenMAIC code — it only chooses this
  // component's own portal host.
  const [fsRoot, setFsRoot] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined'
      ? ((document.fullscreenElement as HTMLElement | null) ?? document.body)
      : null,
  );
  // True while the browser is in native (OS) fullscreen — OpenMAIC enters it
  // on the stage via `stageRef.requestFullscreen()`. In that mode OpenMAIC's
  // own exit affordance (its bottom control bar) is hidden for PBL, so the
  // workspace must offer its own exit button (see the layer).
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  // How many workspace streams are in flight. Lifted to this container — which
  // stays mounted across Hero ↔ workspace — because the workspace layer (and the
  // chat that owns each stream's React state) unmounts when the learner returns
  // to the Hero. The in-flight `run` keeps executing and reports here, so coming
  // back mid-stream shows the "thinking…" indicator again instead of a silent
  // chat. Transient by design: a full page reload ends the streams and resets
  // this together, so there's no stuck indicator.
  //
  // A COUNT, not a boolean: streams can overlap (e.g. an Instructor chat turn
  // plus a submission evaluation). With a single boolean the first stream to
  // settle would clear the flag while the other is still running, re-enabling
  // the Hero reset mid-stream — and that late write would clobber the reset.
  // Counting keeps "busy" true until ALL streams have settled. Each stream
  // reports exactly one `true` on start and one `false` on settle (in a
  // `finally`), so the count stays balanced; `Math.max(0, …)` is a defensive
  // floor against an unmatched decrement.
  const [activeStreamCount, setActiveStreamCount] = useState(0);
  const instructorStreaming = activeStreamCount > 0;
  const handleInstructorStreamingChange = useCallback((active: boolean) => {
    setActiveStreamCount((count) => Math.max(0, active ? count + 1 : count - 1));
  }, []);

  const { runtimeProject, changed } = useMemo(() => {
    const next = structuredClone(projectV2);
    return {
      runtimeProject: next,
      changed: normalizeProjectRuntime(next),
    };
  }, [projectV2]);

  useEffect(() => {
    if (changed) onProjectV2Change(runtimeProject);
  }, [changed, runtimeProject, onProjectV2Change]);

  // Keep the portal host in sync with native fullscreen so the workspace
  // renders inside the fullscreened stage instead of an orphaned <body>.
  useEffect(() => {
    const sync = () => {
      const el = document.fullscreenElement as HTMLElement | null;
      setFsRoot(el ?? document.body);
      setNativeFullscreen(el != null);
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const handleLaunchReady = useCallback(
    (ready: PBLProjectV2) => {
      // Do NOT set `expanded` here: the layer mounts DOCKED and the reveal is
      // driven by flipping `expanded` to true on the next frame (see the layer),
      // so the Hero→workspace grow runs through the reliable prop-change
      // animation path instead of framer's mount `initial` (which React
      // StrictMode's mount/remount skips).
      setAutoExpand(true);
      onProjectV2Change(ready);
    },
    [onProjectV2Change],
  );

  // Return from the workspace to the Hero, keeping all progress intact (only
  // `uiPhase` changes). Resetting `expanded`/`autoExpand` is REQUIRED: the
  // workspace layer unmounts on Hero, and leaving `expanded` true would make
  // the next entry (Continue / Start) mount already-fullscreen, swallowing the
  // 1.3s launch reveal. Clearing them sends the next launch through the same
  // docked → fullscreen grow as a first launch.
  const handleReturnToHero = useCallback(() => {
    setExpanded(false);
    setAutoExpand(false);
    onProjectV2Change(transitionProjectUiPhase(runtimeProject, 'hero'));
  }, [runtimeProject, onProjectV2Change]);

  // Project writes coming FROM the workspace subtree (Instructor / evaluator /
  // submission streams, optimistic edits). A stream that started in the
  // workspace can resolve AFTER the learner stepped back to the Hero — we let
  // it finish in the background so progress isn't lost. Its project clone still
  // carries `uiPhase: 'workspace'`, so writing it verbatim would yank the
  // learner back into the workspace. Read the LIVE phase (not a captured one —
  // this may be invoked by an already-unmounted stream) and, while the learner
  // is on the Hero, keep them there. Explicit navigation (Continue / Completion
  // CTA / reset) goes through `onProjectV2Change` directly and is unaffected.
  const handleWorkspaceProjectChange = useCallback(
    (next: PBLProjectV2) => {
      const liveContent = useStageStore.getState().scenes.find((s) => s.id === sceneId)?.content as
        | PBLContent
        | undefined;
      if (liveContent?.projectV2?.uiPhase === 'hero' && next.uiPhase !== 'hero') {
        onProjectV2Change({ ...next, uiPhase: 'hero' });
        return;
      }
      onProjectV2Change(next);
    },
    [sceneId, onProjectV2Change],
  );

  const content = (() => {
    switch (runtimeProject.uiPhase) {
      case 'workspace':
      case 'completed':
        // Both rendered by the portaled single-instance layer below, so the
        // web-fullscreen frame (and its expanded state + controls) carries
        // across the workspace → completion transition instead of dropping
        // completion back into the small docked host.
        return null;
      case 'generating':
      case 'hero':
      default:
        return (
          <PBLV2Hero
            sceneId={sceneId}
            project={runtimeProject}
            onProjectChange={onProjectV2Change}
            onLaunchReady={handleLaunchReady}
            instructorStreaming={instructorStreaming}
          />
        );
    }
  })();

  return (
    <div ref={hostRef} className="h-full w-full">
      {content}
      {(runtimeProject.uiPhase === 'workspace' || runtimeProject.uiPhase === 'completed') &&
        typeof document !== 'undefined' &&
        createPortal(
          <PBLWorkspaceLayer
            showExpandControl={runtimeProject.uiPhase === 'completed'}
            hostRef={hostRef}
            expanded={expanded}
            autoExpand={autoExpand}
            nativeFullscreen={nativeFullscreen}
            onExpandedChange={setExpanded}
            onAutoExpandConsumed={() => setAutoExpand(false)}
          >
            {runtimeProject.uiPhase === 'completed' ? (
              <PBLV2Completion
                project={runtimeProject}
                onBack={() =>
                  onProjectV2Change(transitionProjectUiPhase(runtimeProject, 'workspace'))
                }
              />
            ) : (
              <PBLV2Workspace
                project={runtimeProject}
                onProjectChange={handleWorkspaceProjectChange}
                onReturnToHero={handleReturnToHero}
                instructorStreaming={instructorStreaming}
                onInstructorStreamingChange={handleInstructorStreamingChange}
                onExpand={expanded || nativeFullscreen ? undefined : () => setExpanded(true)}
              />
            )}
          </PBLWorkspaceLayer>,
          // Portal to a STABLE host (document.body) for the normal case so the
          // Hero→workspace launch reveal survives React's (StrictMode) mount /
          // remount — a state-valued host made framer drop the one-time
          // `initial` animation. Only follow the natively-fullscreened element
          // while native fullscreen is actually on (it never coincides with the
          // launch), so OpenMAIC's native fullscreen still shows the workspace.
          nativeFullscreen ? (fsRoot ?? document.body) : document.body,
        )}
    </div>
  );
}
