'use client';

import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import type { LineFormatToolbarProps, TextToolbarPlacement } from '../types';
import { computeToolbarPosition } from '../text/TextToolbarOverlay';
import { useToolbarAnchor } from '../text/useToolbarAnchor';
import { LineFormatToolbar } from './LineFormatToolbar';

interface ToolbarSize {
  readonly width: number;
  readonly height: number;
}

function equalSizes(left: ToolbarSize | null, right: ToolbarSize) {
  return left?.width === right.width && left.height === right.height;
}

export interface LineToolbarOverlayProps extends LineFormatToolbarProps {
  readonly elementIdPrefix?: string;
}

export function LineToolbarOverlay({
  element,
  elementIdPrefix = 'slide-element-',
  placement = 'top',
  ...toolbarProps
}: LineToolbarOverlayProps) {
  const anchor = useToolbarAnchor(element.id, elementIdPrefix);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState<ToolbarSize | null>(null);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!anchor || !overlay) return;
    const measure = () => {
      const rect = overlay.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const next = { width: rect.width, height: rect.height };
      setToolbarSize((previous) => (equalSizes(previous, next) ? previous : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(overlay);
    return () => observer?.disconnect();
  }, [anchor]);

  if (!anchor || typeof document === 'undefined') return null;
  const position = toolbarSize
    ? computeToolbarPosition(
        anchor,
        toolbarSize,
        { width: window.innerWidth, height: window.innerHeight },
        placement as TextToolbarPlacement,
      )
    : null;

  return createPortal(
    <div
      ref={overlayRef}
      data-toolbar-overlay=""
      data-side={position?.side ?? placement}
      style={{
        left: position ? `${position.left}px` : '0px',
        position: 'fixed',
        top: position ? `${position.top}px` : '0px',
        visibility: position ? 'visible' : 'hidden',
        zIndex: 'var(--maic-editing-ui-z-index, 80)',
      }}
    >
      <LineFormatToolbar element={element} placement={placement} {...toolbarProps} />
    </div>,
    document.body,
  );
}
