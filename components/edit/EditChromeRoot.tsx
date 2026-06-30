'use client';

import { useEffect } from 'react';
import { EditShell } from '@/components/edit/EditShell';
import { SlideNavRail } from '@/components/edit/SlideNavRail';
import { ActionsBar } from '@/components/edit/ActionsBar/ActionsBar';
import { HeaderControls } from '@/components/stage/header-controls';
import { useAgentRuntime } from '@/lib/agent/client/use-agent-runtime';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { preloadEditor } from '@/lib/edit/preload-editor';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import type { Scene } from '@/lib/types/stage';
import { RightRailTabs } from '@/components/edit/RightRailTabs';

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
 * `SlideNavRail` (leftRail slot), the `HeaderControls` trailing
 * (settings pill + Pro Switch) that rides in CommandBar's right slot,
 * and the tabbed `RightRailTabs` (Edit with AI + 角色 roster).
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

  // The AI edit panel is decoupled from the canvas surface: it renders wherever
  // the agent has an edit capability — slides (regenerate) AND interactive scenes
  // (edit_interactive_html), even though the interactive canvas itself stays view-only.
  const agentEnabled = authoringEnabled || scene.type === 'interactive';

  // Keep the runtime owned by Pro mode chrome, not by the scene-capability gated
  // panel. Unsupported scene switches can hide/disable the composer without
  // destroying an in-flight run or the messages that still need to settle/save.
  const agentRuntime = useAgentRuntime({
    scene: agentEnabled ? { id: scene.id, title: scene.title } : undefined,
    isSendDisabled: !agentEnabled,
  });

  const headerControls = (
    <HeaderControls
      mode="edit"
      canEdit={isEditable}
      onToggleEditMode={isMaicEditorEnabled() ? onToggleEditMode : undefined}
    />
  );

  return (
    <EditShell
      scene={scene}
      leftRail={<SlideNavRail />}
      rightRail={
        <RightRailTabs
          scene={{ id: scene.id, title: scene.title, type: scene.type }}
          runtime={agentRuntime.runtime}
          clearThread={agentRuntime.clearThread}
          hasMessages={agentRuntime.hasMessages}
          canSend={agentEnabled}
          agentEnabled={agentEnabled}
          isRunning={agentRuntime.isRunning}
          sessions={agentRuntime.sessions}
          activeSessionId={agentRuntime.activeSessionId}
          switchSession={agentRuntime.switchSession}
          deleteSessionAndRefresh={agentRuntime.deleteSessionAndRefresh}
          refreshSessions={agentRuntime.refreshSessions}
        />
      }
      bottomRail={authoringEnabled ? <ActionsBar sceneId={scene.id} /> : undefined}
      commandTrailing={headerControls}
    />
  );
}
