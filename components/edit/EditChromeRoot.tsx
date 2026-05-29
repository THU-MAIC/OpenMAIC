'use client';

import { useEffect, useState } from 'react';
import { EditShell } from '@/components/edit/EditShell';
import { SlideNavRail } from '@/components/edit/SlideNavRail';
import { HeaderControls } from '@/components/stage/header-controls';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
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

  // Editor-only side effects are deferred to here so flag-off
  // classroom/playback users never pay for them at module load:
  //   1. `editor-fonts` injects ~23 @fontsource font-face tables that
  //      only the slide font picker needs (CSS side effect, fire-and-forget).
  //   2. `surfaces/slide` registers the slide SceneEditorSurface into
  //      `sceneEditorRegistry`. EditShell resolves the registry and falls
  //      back to NOOP_SURFACE (read-only) for an unregistered type, so we
  //      hold the EditShell render until the slide surface has registered
  //      to avoid a NOOP/read-only flash on first paint of Pro mode.
  const [surfaceReady, setSurfaceReady] = useState(false);
  useEffect(() => {
    let active = true;
    void import('@/app/editor-fonts');
    void import('@/components/edit/surfaces/slide').then(() => {
      if (active) setSurfaceReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!surfaceReady) return null;

  return (
    <EditShell
      scene={scene}
      leftRail={<SlideNavRail />}
      commandTrailing={
        <HeaderControls
          mode="edit"
          canEdit={isEditable}
          onToggleEditMode={isMaicEditorEnabled() ? onToggleEditMode : undefined}
        />
      }
    />
  );
}
