'use client';

import type { ReactNode } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useCanvasStore } from '@/lib/store/canvas';
import { useTrackedRect } from './use-tracked-rect';

interface AnchoredBarProps {
  /** The element to anchor to, or "" when the bar should not show. */
  readonly elementId: string;
  readonly children: ReactNode;
}

/**
 * The generic selection-anchored bar shell — a Radix Popover positioned against
 * a virtual anchor: an invisible fixed-positioned box at the element's live
 * screen rect (from useTrackedRect). PopoverContent is portaled, so the canvas's
 * overflow-hidden never clips it, and Radix flips it below / clamps it
 * horizontally on its own. AnchoredTextBar and AnchoredDeleteBar supply the
 * contents.
 */
export function AnchoredBar({ elementId, children }: AnchoredBarProps) {
  const rect = useTrackedRect(elementId);
  const open = elementId !== '' && rect !== null;

  return (
    <Popover
      open={open}
      // Selection-driven close path: when Radix wants to close (Esc, or any
      // dismiss our hardening doesn't intercept) we clear the canvas selection
      // — which then closes us via the controlled `open` prop. Also silences
      // Radix's controlled-without-onOpenChange dev warning and keeps Esc /
      // SR dismissal working.
      onOpenChange={(o) => {
        if (!o) useCanvasStore.getState().setActiveElementIdList([]);
      }}
    >
      {rect && (
        <PopoverAnchor asChild>
          <div
            aria-hidden
            style={{
              position: 'fixed',
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              pointerEvents: 'none',
            }}
          />
        </PopoverAnchor>
      )}
      {open && (
        <PopoverContent
          side="top"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          // Mirrors the FloatingToolbar popover hardening: opening the bar must
          // not pull focus off the canvas selection, and commands that refocus
          // the editor must not dismiss it — so it stays up across consecutive
          // clicks. Visibility is fully selection-driven: the bar closes when
          // the canvas selection clears or changes (via the controlled `open`),
          // *not* via Radix's pointer/focus-outside dismiss. preventDefault on
          // pointer-down-outside too is essential — otherwise mousedown on the
          // selected element (to drag-to-move or to resize-handle) triggers
          // Radix's dismiss → `onOpenChange(false)` → we'd clear the selection
          // before the drag could start. Esc still routes through onOpenChange.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          className="w-auto max-w-[92vw] p-1"
        >
          {children}
        </PopoverContent>
      )}
    </Popover>
  );
}
