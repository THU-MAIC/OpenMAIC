'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { motion } from 'motion/react';
import type { PBLContent, StageMode } from '@/lib/types/stage';
import type { PBLProjectConfig } from '@/lib/pbl/types';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import {
  isEmptyLegacyPBLConfig,
  projectV2ToLegacyProjectConfig,
  upgradeLegacyPBLConfigToProjectV2,
} from '@/lib/pbl/v2/compat';
import { normalizeProjectRuntime } from '@/lib/pbl/v2/operations/progress';
import { transitionProjectUiPhase } from '@/lib/pbl/v2/operations/runtime-events';
import { useStageStore } from '@/lib/store/stage';
import { cn } from '@/lib/utils/cn';
import { PBLRoleSelection } from './pbl/role-selection';
import { PBLWorkspace } from './pbl/workspace';
import { PBLV2Hero } from './pbl/v2/hero';
import { PBLV2Workspace } from './pbl/v2/workspace';
import { PBLV2Completion } from './pbl/v2/completion';
import { rectsEqual, type LayoutRect } from './pbl/v2/host-rect';
import { useI18n } from '@/lib/hooks/use-i18n';

const IMMERSIVE_LAUNCH_DURATION_SECONDS = 0.45;
// The one-time Hero → workspace launch gets a slower, more deliberate
// reveal; every later manual expand uses the snappy default above. The
// even ease (vs. the front-loaded launch ease) spreads the motion across
// the whole launch so the grow, the workspace fade-in and the backdrop
// dim progress together and the page behind fades away gradually.
const HERO_LAUNCH_EXPAND_DURATION_SECONDS = 1.3;
const HERO_LAUNCH_EXPAND_EASE = [0.4, 0, 0.2, 1] as const;
const IMMERSIVE_EXIT_DURATION_SECONDS = 0.4;
const IMMERSIVE_LAUNCH_EASE = [0.16, 1, 0.3, 1] as const;
const IMMERSIVE_EXIT_EASE = [0.4, 0, 0.2, 1] as const;

interface PBLRendererProps {
  readonly content: PBLContent;
  readonly mode: StageMode;
  readonly sceneId: string;
}

export function PBLRenderer({ content, mode: _mode, sceneId }: PBLRendererProps) {
  const { t } = useI18n();

  const { projectConfig } = content;
  const selectedRole = projectConfig?.selectedRole ?? null;
  const resolvedProjectV2 = useMemo(() => {
    if (content.projectV2) return content.projectV2;
    if (!projectConfig || isEmptyLegacyPBLConfig(projectConfig)) return null;
    return upgradeLegacyPBLConfigToProjectV2(projectConfig);
  }, [content.projectV2, projectConfig]);

  const updateConfig = useCallback(
    (updatedConfig: PBLProjectConfig) => {
      useStageStore.getState().updateScene(sceneId, {
        content: { type: 'pbl' as const, projectConfig: updatedConfig },
      });
    },
    [sceneId],
  );

  const handleSelectRole = useCallback(
    (roleName: string) => {
      if (!projectConfig) return;
      const newConfig = { ...projectConfig, selectedRole: roleName };

      // Add Question Agent welcome message if chat is empty and active issue has questions
      const activeIssue = newConfig.issueboard.issues.find((i) => i.is_active);
      if (activeIssue?.generated_questions && newConfig.chat.messages.length === 0) {
        newConfig.chat = {
          messages: [
            {
              id: `msg_welcome_${Date.now()}`,
              agent_name: activeIssue.question_agent_name,
              message: activeIssue.generated_questions,
              timestamp: Date.now(),
              read_by: [],
            },
          ],
        };
      }

      updateConfig(newConfig);
    },
    [projectConfig, updateConfig, t], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const handleReset = useCallback(() => {
    if (!projectConfig) return;
    // Reset all issues and re-activate the first one
    const resetIssues = projectConfig.issueboard.issues
      .map((i) => ({ ...i, is_done: false, is_active: false }))
      .sort((a, b) => a.index - b.index);
    if (resetIssues.length > 0) {
      resetIssues[0].is_active = true;
    }

    updateConfig({
      ...projectConfig,
      selectedRole: null,
      chat: { messages: [] },
      issueboard: {
        ...projectConfig.issueboard,
        issues: resetIssues,
        current_issue_id: resetIssues.length > 0 ? resetIssues[0].id : null,
      },
    });
  }, [projectConfig, updateConfig]);

  if (resolvedProjectV2) {
    return (
      <PBLV2Container
        sceneId={sceneId}
        projectV2={resolvedProjectV2}
        onProjectV2Change={(next) => {
          useStageStore.getState().updateScene(sceneId, {
            content: {
              ...content,
              projectConfig: projectV2ToLegacyProjectConfig(next),
              projectV2: next,
            },
          });
        }}
      />
    );
  }

  // Check for legacy format (old PBL with url/html)
  if (!projectConfig) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>{t('pbl.legacyFormat')}</p>
      </div>
    );
  }

  // Check if project has been generated (has agents)
  if (projectConfig.agents.length === 0 && projectConfig.projectInfo.title === '') {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p>{t('pbl.emptyProject')}</p>
      </div>
    );
  }

  // No role selected → show role selection
  if (!selectedRole) {
    return (
      <PBLRoleSelection
        projectInfo={projectConfig.projectInfo}
        agents={projectConfig.agents}
        onSelectRole={handleSelectRole}
      />
    );
  }

  // Role selected → show workspace
  return (
    <PBLWorkspace
      projectConfig={projectConfig}
      userRole={selectedRole}
      onConfigUpdate={updateConfig}
      onReset={handleReset}
    />
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
          <PBLV2WorkspaceLayer
            project={runtimeProject}
            onProjectChange={handleWorkspaceProjectChange}
            onReturnToHero={handleReturnToHero}
            instructorStreaming={instructorStreaming}
            onInstructorStreamingChange={handleInstructorStreamingChange}
            hostRef={hostRef}
            expanded={expanded}
            autoExpand={autoExpand}
            nativeFullscreen={nativeFullscreen}
            onExpandedChange={setExpanded}
            onAutoExpandConsumed={() => setAutoExpand(false)}
          />,
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

function measureHostRect(hostRef: RefObject<HTMLDivElement | null>): LayoutRect {
  const rect = hostRef.current?.getBoundingClientRect();
  if (rect) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  if (typeof window === 'undefined') return { left: 0, top: 0, width: 0, height: 0 };
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/**
 * The single, persistent web-fullscreen frame for the workspace AND the
 * completion phases. It is portaled to <body> and `position: fixed`, so
 * it can cover the viewport when expanded while the React-tree position
 * stays stable — meaning the inner <PBLV2Workspace> (and its chat /
 * stream state) is never remounted by an expand/collapse toggle.
 *
 * Hosting both phases here is what lets the fullscreen state survive the
 * workspace → completion transition: the frame stays mounted, only its
 * inner content swaps, so the learner keeps the same docked/expanded view
 * (and its controls) instead of completion dropping back to a small box.
 *
 * - docked: the frame is positioned over the host (scene) box, with no
 *   drop-shadow/backdrop, so it looks identical to the previous inline
 *   layout.
 * - expanded: the frame animates to the viewport with a backdrop, and
 *   shows the collapse (Minimize) control.
 */
function PBLV2WorkspaceLayer({
  project,
  onProjectChange,
  onReturnToHero,
  instructorStreaming,
  onInstructorStreamingChange,
  hostRef,
  expanded,
  autoExpand,
  nativeFullscreen,
  onExpandedChange,
  onAutoExpandConsumed,
}: {
  readonly project: PBLProjectV2;
  readonly onProjectChange: (next: PBLProjectV2) => void;
  readonly onReturnToHero: () => void;
  readonly instructorStreaming: boolean;
  readonly onInstructorStreamingChange: (active: boolean) => void;
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly expanded: boolean;
  readonly autoExpand: boolean;
  readonly nativeFullscreen: boolean;
  readonly onExpandedChange: (next: boolean) => void;
  readonly onAutoExpandConsumed: () => void;
}) {
  const { t } = useI18n();
  const isCompleted = project.uiPhase === 'completed';
  const [hostRect, setHostRect] = useState<LayoutRect>(() => measureHostRect(hostRef));

  // Animate ONLY the expand/collapse toggle (and the launch auto-expand).
  // Plain host-rect tracking while docked must apply instantly, otherwise
  // the frame would lag behind window/sidebar resizes.
  const prevExpandedRef = useRef(expanded);
  const isToggle = prevExpandedRef.current !== expanded;
  useEffect(() => {
    prevExpandedRef.current = expanded;
  });

  // Keep the docked frame aligned with the host (scene) box across window
  // resizes, sidebar toggles and scrolls.
  useEffect(() => {
    const host = hostRef.current;
    let raf = 0;
    let last: LayoutRect | null = null;

    // Dirty-checked apply: only push React state when the rect actually
    // changed, so the per-frame poll below stays free while the box is still.
    const sync = () => {
      const next = measureHostRect(hostRef);
      if (!last || !rectsEqual(last, next)) {
        last = next;
        setHostRect(next);
      }
    };
    sync();

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    if (observer && host) observer.observe(host);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);

    // Side-panel toggles re-CENTER the height-constrained 16:9 host box without
    // resizing it: the box only MOVES, so ResizeObserver / resize / scroll never
    // fire and the position:fixed docked frame would stay put — leaking the
    // (correctly reflowed) box beside it. While docked, also poll the rect every
    // animation frame (a cheap getBoundingClientRect + the dirty-check above, so
    // React state changes only when the box truly moves) so the frame tracks the
    // slide. Not needed while expanded — the frame is fullscreen, not
    // host-aligned — so the loop is skipped (and torn down) in that mode.
    if (!expanded) {
      const tick = () => {
        sync();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostRef, expanded]);

  // Hero launch reveal. The layer mounts DOCKED; on the next frame we flip
  // `expanded` to true so the grow runs through the SAME prop-change animation
  // as manual maximize (reliable, and unaffected by React StrictMode's
  // mount/remount — unlike framer's mount `initial`, which it skips). Keep
  // `autoExpand` (slow 1.3s Hero timing) until the reveal has played, then
  // consume it so later manual expands use the snappy default.
  useEffect(() => {
    if (!autoExpand) return;
    const raf = requestAnimationFrame(() => onExpandedChange(true));
    const consume = window.setTimeout(
      onAutoExpandConsumed,
      HERO_LAUNCH_EXPAND_DURATION_SECONDS * 1000 + 120,
    );
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(consume);
    };
    // Re-run when `autoExpand` flips true so the reveal fires whether the flag
    // is already set at mount (the normal case) or arrives just after; the
    // callbacks are effectively stable for this one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExpand]);

  // Lock background scroll only while the workspace owns the viewport.
  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  const dockedStyle = {
    left: hostRect.left,
    top: hostRect.top,
    width: hostRect.width,
    height: hostRect.height,
    borderRadius: 8,
  };
  const fullscreenStyle = {
    left: 0,
    top: 0,
    width: '100vw',
    height: '100dvh',
    borderRadius: 0,
  };
  const animateFrame = isToggle || autoExpand;
  // `autoExpand` is true only on the first Hero launch render → that one
  // time gets the slower, evenly-paced reveal (geometry + the workspace's
  // own fade-in + the backdrop dim all share this transition, so the page
  // behind fades away gradually across the whole launch). Manual maximize
  // keeps the snappy default.
  const expandDuration = autoExpand
    ? HERO_LAUNCH_EXPAND_DURATION_SECONDS
    : IMMERSIVE_LAUNCH_DURATION_SECONDS;
  const expandEase = autoExpand ? HERO_LAUNCH_EXPAND_EASE : IMMERSIVE_LAUNCH_EASE;
  const transition = animateFrame
    ? {
        duration: expanded ? expandDuration : IMMERSIVE_EXIT_DURATION_SECONDS,
        ease: expanded ? expandEase : IMMERSIVE_EXIT_EASE,
      }
    : { duration: 0 };

  return (
    <>
      <motion.div
        className={cn(
          'pointer-events-none fixed inset-0 bg-background/80 backdrop-blur-sm',
          // Docked stays a z-auto stacking context (see the frame note); it is
          // invisible while docked anyway. Expanded dims the whole page on top.
          expanded ? 'z-[110]' : 'isolate',
        )}
        initial={false}
        animate={{ opacity: expanded ? 1 : 0 }}
        transition={transition}
      />
      <motion.div
        className={cn(
          'fixed overflow-hidden bg-background text-foreground',
          // Docked must behave like ordinary in-page content: NO positive
          // z-index. Header dropdowns portal to <body>, but their Radix popper
          // wrapper is z-auto (the `z-50` lives on the inner content, trapped by
          // the wrapper's transform). A positive z here (even z-1) would paint
          // over that wrapper and clip the menu. `isolate` gives the docked
          // layer a z-auto stacking context that still covers all in-app scene
          // content (it outranks the static app root) yet sits below the
          // later-mounted dropdown portal. Expanded is a full takeover on top.
          expanded ? 'z-[120]' : 'isolate',
          expanded && 'shadow-[0_24px_90px_rgba(0,0,0,0.38)] ring-1 ring-white/10',
        )}
        initial={false}
        animate={{ ...(expanded ? fullscreenStyle : dockedStyle), opacity: 1 }}
        transition={transition}
      >
        {/* Native (OS) fullscreen takes over the top-right slot: OpenMAIC's
            own exit bar is hidden for PBL, so this is the only click target
            to leave true fullscreen (Esc still works, handled by OpenMAIC).
            `document.exitFullscreen()` triggers OpenMAIC's own fullscreenchange
            cleanup (keyboard unlock etc.) — we never touch OpenMAIC code. The
            violet, borderless-ish treatment mirrors OpenMAIC's native control
            so it reads differently from the neutral web-fullscreen buttons. */}
        {nativeFullscreen ? (
          <button
            type="button"
            onClick={() => {
              document.exitFullscreen?.().catch(() => {});
            }}
            className="absolute right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-md border border-violet-300/35 bg-violet-500/20 text-violet-100 shadow-sm backdrop-blur transition-colors hover:bg-violet-500/30"
            aria-label={t('pbl.v2.workspace.exitNativeFullscreen')}
            title={t('pbl.v2.workspace.exitNativeFullscreen')}
          >
            <Minimize2 className="h-4 w-4" />
          </button>
        ) : (
          <>
            {expanded && (
              <button
                type="button"
                onClick={() => onExpandedChange(false)}
                className="absolute right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-background/75 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
                aria-label={t('pbl.v2.workspace.exitFullscreen')}
                title={t('pbl.v2.workspace.exitFullscreen')}
              >
                <Minimize2 className="h-4 w-4" />
              </button>
            )}
            {/* The Workspace carries its own in-topbar expand control, so the
                layer only needs to supply the docked → fullscreen affordance
                for Completion (which has no topbar of its own). */}
            {!expanded && isCompleted && (
              <button
                type="button"
                onClick={() => onExpandedChange(true)}
                className="absolute right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-background/75 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
                aria-label={t('pbl.v2.workspace.enterFullscreen')}
                title={t('pbl.v2.workspace.enterFullscreen')}
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            )}
          </>
        )}
        <div className="relative z-10 h-full w-full">
          {isCompleted ? (
            <PBLV2Completion
              project={project}
              onBack={() => onProjectChange(transitionProjectUiPhase(project, 'workspace'))}
            />
          ) : (
            <PBLV2Workspace
              project={project}
              onProjectChange={onProjectChange}
              onReturnToHero={onReturnToHero}
              instructorStreaming={instructorStreaming}
              onInstructorStreamingChange={onInstructorStreamingChange}
              onExpand={expanded || nativeFullscreen ? undefined : () => onExpandedChange(true)}
            />
          )}
        </div>
      </motion.div>
    </>
  );
}
