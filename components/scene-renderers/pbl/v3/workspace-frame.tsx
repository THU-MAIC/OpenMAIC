'use client';
import type { ReactNode } from 'react';
import { usePblActivityInput } from './activity-provider';
import './workbench.css';

/** Layout only: the shared classroom layer owns expansion/fullscreen. */
export function WorkspaceFrame({ sceneId, children }: { sceneId: string; children: ReactNode }) {
  const input = usePblActivityInput(sceneId);
  return (
    <div
      data-testid="pbl-v3-frame"
      // Capture project interactions (including React portals), never classroom navigation.
      onPointerDownCapture={input}
      onKeyDownCapture={input}
      onWheelCapture={input}
      className="wbchat pbl-workbench relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
