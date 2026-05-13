'use client';

import { motion } from 'motion/react';
import type { SceneEditorSurface } from '@/lib/edit/scene-editor-surface';
import { CommandBar } from './CommandBar';
import { FloatingToolbar } from './FloatingToolbar';
import { HintRail } from './HintRail';

interface EditShellProps {
  readonly surface: SceneEditorSurface;
  readonly title: string;
  readonly sidebarCollapsed?: boolean;
  readonly onToggleSidebar?: () => void;
}

const CHROME_TRANSITION = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Pitch-inspired shell:
 *   ┌──────────────────────────────────────────────┐
 *   │ Top:  [↶↷ title]  [Insert items]  [view]     │
 *   │  ┌──────────────────────────────────────┐    │
 *   │  │  Canvas (full width below top bar)   │    │
 *   │  │     • FloatingToolbar (selection-    │    │
 *   │  │       contextual; holds property      │    │
 *   │  │       popovers + duplicate/delete)    │    │
 *   │  └──────────────────────────────────────┘    │
 *   └──────────────────────────────────────────────┘
 *
 * No fixed right inspector — properties live in the floating toolbar's
 * popovers. Left edge belongs to the EditModeSidebar (slide thumbnails)
 * provided by the parent Stage layout.
 */
export function EditShell({ surface, title, sidebarCollapsed, onToggleSidebar }: EditShellProps) {
  const state = surface.useSurfaceState();
  const Canvas = surface.CanvasComponent;

  return (
    <div className="flex h-full w-full flex-col bg-zinc-50 dark:bg-zinc-950">
      <motion.div
        initial={{ y: -56, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={CHROME_TRANSITION}
      >
        <CommandBar
          title={title}
          history={state.history}
          insertItems={state.insertItems}
          commands={state.commands}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
        />
      </motion.div>
      <div className="relative min-h-0 flex-1">
        <Canvas />
        {state.hasSelection && <FloatingToolbar actions={state.floatingActions} />}
        <HintRail hints={state.hints} />
      </div>
    </div>
  );
}
