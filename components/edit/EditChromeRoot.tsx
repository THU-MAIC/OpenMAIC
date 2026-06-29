'use client';

import { useEffect } from 'react';
import { EditShell } from '@/components/edit/EditShell';
import { SlideNavRail } from '@/components/edit/SlideNavRail';
import { AgentPanel } from '@/components/edit/AgentPanel/AgentPanel';
import { ActionsBar } from '@/components/edit/ActionsBar/ActionsBar';
import { HeaderControls } from '@/components/stage/header-controls';
import { useAgentRuntime } from '@/lib/agent/client/use-agent-runtime';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { preloadEditor } from '@/lib/edit/preload-editor';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import type { Scene } from '@/lib/types/stage';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store/stage';
import { AgentsView } from '@/components/edit/AgentsView/AgentsView';
import { shouldRenderAgentPanel } from './agent-panel-visibility';

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
 * `SlideNavRail` (leftRail slot), and the `HeaderControls` trailing
 * (settings pill + Pro Switch) that rides in CommandBar's right slot.
 *
 * NOT owned here:
 * - `MultiTabEditConflictPrompt` — must mount even in playback mode so
 *   the lock-conflict dialog can be shown when entering edit mode is
 *   refused (mode is still 'playback' at that point).
 * - `useEditModeLock` — the lock is acquired by the Pro toggle in
 *   stage.tsx BEFORE the live session is torn down, so it can't live
 *   in a component that only mounts after the switch.
 *
 * `scene` is required (non-null). The parent gates mounting on
 * `mode === 'edit' && currentScene` to satisfy this contract.
 */
export function EditChromeRoot({ scene, isEditable, onToggleEditMode }: EditChromeRootProps) {
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

  // The narration timeline (ActionsBar) is a slide-narration authoring tool — it
  // only applies to scene types with a registered editor surface (slide/quiz).
  // Read-only canvas scenes (no surface → NOOP + the "· view-only" badge, e.g.
  // interactive/PBL) get no timeline.
  const authoringEnabled = !!sceneEditorRegistry.resolve(scene.type);

  // The AI edit panel (AgentPanel) is decoupled from the canvas surface: it
  // renders wherever the agent has an edit capability — slides (regenerate) AND
  // interactive scenes (edit_interactive_html), even though the interactive canvas
  // itself stays view-only. PBL has neither a surface nor an agent edit tool.
  const agentEnabled = authoringEnabled || scene.type === 'interactive';
  // Keep the runtime owned by Pro mode chrome, not by the scene-capability gated
  // panel. Unsupported scene switches can hide/disable the composer without
  // destroying an in-flight run or the messages that still need to settle/save.
  const agentRuntime = useAgentRuntime({
    scene: agentEnabled ? { id: scene.id, title: scene.title } : undefined,
    isSendDisabled: !agentEnabled,
  });
  const showAgentPanel = shouldRenderAgentPanel({
    agentEnabled,
    hasMessages: agentRuntime.hasMessages,
    isRunning: agentRuntime.isRunning,
  });

  const viewMode = useStageStore.use.viewMode();
  const setViewMode = useStageStore.use.setViewMode();

  // [Slides] / [Agents] segmented toggle — passed into CommandBar's `leading`
  // slot in both modes so the chrome layout stays consistent.
  const viewToggle = <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />;

  // The HeaderControls (settings pill + Pro Switch) are shared across both
  // modes; build them once and pass as `commandTrailing`.
  const headerControls = (
    <HeaderControls
      mode="edit"
      canEdit={isEditable}
      onToggleEditMode={isMaicEditorEnabled() ? onToggleEditMode : undefined}
    />
  );

  if (viewMode === 'agents') {
    return (
      <AgentsView
        commandLeading={viewToggle}
        commandTrailing={headerControls}
      />
    );
  }

  return (
    <EditShell
      scene={scene}
      leftRail={<SlideNavRail />}
      rightRail={
        showAgentPanel ? (
          <AgentPanel
            scene={{ id: scene.id, title: scene.title, type: scene.type }}
            runtime={agentRuntime.runtime}
            clearThread={agentRuntime.clearThread}
            hasMessages={agentRuntime.hasMessages}
            canSend={agentEnabled}
            sessions={agentRuntime.sessions}
            activeSessionId={agentRuntime.activeSessionId}
            switchSession={agentRuntime.switchSession}
            deleteSessionAndRefresh={agentRuntime.deleteSessionAndRefresh}
            refreshSessions={agentRuntime.refreshSessions}
          />
        ) : undefined
      }
      bottomRail={authoringEnabled ? <ActionsBar sceneId={scene.id} /> : undefined}
      commandLeading={viewToggle}
      commandTrailing={headerControls}
    />
  );
}

// ---------------------------------------------------------------------------
// ViewModeToggle — [Slides] [Agents] segmented control
// ---------------------------------------------------------------------------

interface ViewModeToggleProps {
  readonly viewMode: 'slides' | 'agents';
  readonly setViewMode: (mode: 'slides' | 'agents') => void;
}

function ViewModeToggle({ viewMode, setViewMode }: ViewModeToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="编辑视图"
      className="flex items-center gap-0.5 rounded-xl bg-zinc-100 p-0.5 dark:bg-zinc-800"
    >
      <ViewTab
        label="幻灯片"
        active={viewMode === 'slides'}
        onClick={() => setViewMode('slides')}
      />
      <ViewTab
        label="角色"
        active={viewMode === 'agents'}
        onClick={() => setViewMode('agents')}
      />
    </div>
  );
}

function ViewTab({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded-lg px-3 py-1 text-xs font-semibold transition-all',
        active
          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
      )}
    >
      {label}
    </button>
  );
}
