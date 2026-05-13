'use client';

import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import { sceneEditorRegistry } from '@/lib/edit/scene-editor-registry';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { Scene } from '@/lib/types/stage';
import { CommandBar } from './CommandBar';
import { FloatingToolbar } from './FloatingToolbar';
import { HintRail } from './HintRail';

interface EditShellProps {
  readonly scene: Scene;
  /**
   * Optional left-side navigator slot. v0 ships with this empty — a future
   * sub-PR will plug in the redesigned slide-navigation surface here. The
   * prop is preserved as an extension point so Stage doesn't need to grow a
   * new layout when that lands.
   */
  readonly leftRail?: ReactNode;
}

const CHROME_TRANSITION = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Pro mode (edit) chrome — mounts inside the canvas slot of Stage, replacing
 * CanvasArea. The playback Header above stays mounted because it owns the
 * global Pro toggle Switch: exiting Pro mode is done by flipping that Switch
 * off, not by a dedicated button here.
 *
 *   ┌──────────────────────────────────────────────┐  (Stage Header above)
 *   ├──────────────────────────────────────────────┤
 *   │ CommandBar  (undo/redo · title · insert ·    │
 *   │              surface commands)                │
 *   ├──────────┬───────────────────────────────────┤
 *   │ leftRail │ Canvas / unsupported-scene        │
 *   │ (opt)    │ FloatingToolbar (when selected)   │
 *   │          │ HintRail (AI, reserved)            │
 *   └──────────┴───────────────────────────────────┘
 *
 * When a surface is registered for `scene.type`, EditShell renders that
 * surface's canvas and reads its useSurfaceState() into the CommandBar /
 * FloatingToolbar / HintRail slots. When none is registered, it falls
 * through to the `edit.unsupportedScene` placeholder — the visible v0
 * behavior since no surfaces ship in this PR.
 */
export function EditShell({ scene, leftRail }: EditShellProps) {
  const surface = sceneEditorRegistry.resolve(scene.type);

  if (surface) {
    return <EditShellWithSurface scene={scene} surface={surface} leftRail={leftRail} />;
  }
  return <EditShellFallback scene={scene} leftRail={leftRail} />;
}

interface ResolvedShellProps {
  readonly scene: Scene;
  readonly leftRail?: ReactNode;
}

function EditShellWithSurface({
  scene,
  surface,
  leftRail,
}: ResolvedShellProps & { readonly surface: SceneEditorSurface }) {
  const { t } = useI18n();
  const sceneTypeLabel = t(`edit.sceneType.${scene.type}`);
  const title = t('edit.title', { type: sceneTypeLabel });
  const state = surface.useSurfaceState();
  const Canvas = surface.CanvasComponent;

  return (
    <Frame
      title={title}
      leftRail={leftRail}
      history={state.history}
      insertItems={state.insertItems}
      commands={state.commands}
    >
      <Canvas />
      {state.hasSelection && <FloatingToolbar actions={state.floatingActions} />}
      <HintRail hints={state.hints} />
    </Frame>
  );
}

function EditShellFallback({ scene, leftRail }: ResolvedShellProps) {
  const { t } = useI18n();
  const sceneTypeLabel = t(`edit.sceneType.${scene.type}`);
  const title = t('edit.title', { type: sceneTypeLabel });

  return (
    <Frame title={title} leftRail={leftRail}>
      <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
        {t('edit.unsupportedScene', { type: sceneTypeLabel })}
      </div>
    </Frame>
  );
}

interface FrameProps {
  readonly title: string;
  readonly leftRail?: ReactNode;
  readonly history?: React.ComponentProps<typeof CommandBar>['history'];
  readonly insertItems?: React.ComponentProps<typeof CommandBar>['insertItems'];
  readonly commands?: React.ComponentProps<typeof CommandBar>['commands'];
  readonly children: ReactNode;
}

function Frame({ title, leftRail, history, insertItems, commands, children }: FrameProps) {
  return (
    <div className="flex h-full w-full flex-col bg-zinc-50 dark:bg-zinc-950">
      <motion.div
        initial={{ y: -56, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={CHROME_TRANSITION}
      >
        <CommandBar title={title} history={history} insertItems={insertItems} commands={commands} />
      </motion.div>
      <div className="flex min-h-0 flex-1">
        {leftRail}
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
