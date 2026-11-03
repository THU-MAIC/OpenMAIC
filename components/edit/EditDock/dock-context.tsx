'use client';

/**
 * Edit dock context — what the dock lends the timeline.
 *
 * The dock owns the surface: the top border, the blur, the control bar and the
 * height. The narration timeline owns its own controls, because they and its body
 * share state (the insert-picker anchor, the TTS batch, the focused clip). They
 * show in the control bar, though, so the dock lends the timeline a place there
 * (`barActions`) and a way to open it.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export interface EditDockContextValue {
  /** Open a folded dock, for what cannot be done without seeing the timeline. */
  expand: () => void;
  /** Where the timeline's own actions go in the control bar; null outside a dock. */
  barActions: HTMLElement | null;
}

/** An action in the control bar's pill: playback's control button, icon only. */
export const DOCK_BAR_ACTION =
  'relative inline-flex h-6 shrink-0 items-center justify-center rounded-md text-gray-500 outline-none transition-all duration-150 hover:bg-gray-500/[0.08] active:scale-90 focus-visible:ring-1 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-35 dark:text-gray-400 dark:hover:bg-gray-400/[0.08]';

/** The pill's buttons have no words of their own, so they say it the way playback's do. */
export function DockBarTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const EditDockContext = createContext<EditDockContextValue | null>(null);

export function EditDockProvider({
  value,
  children,
}: {
  value: EditDockContextValue;
  children: ReactNode;
}) {
  return <EditDockContext.Provider value={value}>{children}</EditDockContext.Provider>;
}

/**
 * Read what the dock lends. Returns a neutral value when the timeline is rendered
 * outside a dock (an isolated test, a future standalone mount) so it is never
 * coupled to the shell being there.
 */
export function useEditDock(): EditDockContextValue {
  return (
    useContext(EditDockContext) ?? {
      expand: () => undefined,
      barActions: null,
    }
  );
}
