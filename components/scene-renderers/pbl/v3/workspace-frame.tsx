'use client';
import type { ReactNode } from 'react';
import './workbench.css';

/** Layout only: the shared classroom layer owns expansion/fullscreen. */
export function WorkspaceFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="pbl-v3-frame"
      className="wbchat pbl-workbench relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
