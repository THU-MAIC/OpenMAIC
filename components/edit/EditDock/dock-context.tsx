'use client';

/**
 * Edit dock context — the fold the dock owns and the timeline operates.
 *
 * The dock owns the surface: the top border, the blur, the drag-resize handle,
 * the global edit bar and the height. The narration timeline owns everything
 * below that bar — including its own header row, because that row's controls and
 * its body share one piece of state (the insert-picker anchor, the TTS batch, the
 * focused clip). So the shell cannot render the row; it lends the timeline the
 * fold instead, and the timeline puts the toggle at the end of its own row where
 * the title has always been able to reach it.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface EditDockContextValue {
  /**
   * The dock is folded. The timeline's collapsed form is its axis of node icons
   * (still a body), so it reads this rather than being hidden by the shell.
   */
  collapsed: boolean;
  toggleCollapsed: () => void;
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
 * Read the dock's fold. Returns a neutral value when the timeline is rendered
 * outside a dock (an isolated test, a future standalone mount) so it is never
 * coupled to the shell being there.
 */
export function useEditDock(): EditDockContextValue {
  return useContext(EditDockContext) ?? { collapsed: false, toggleCollapsed: () => undefined };
}
