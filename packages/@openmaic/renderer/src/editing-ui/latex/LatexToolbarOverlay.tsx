'use client';

import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { PencilLine } from 'lucide-react';
import type { PPTLatexElement } from '@openmaic/dsl';
import { computeToolbarPosition } from '../text/TextToolbarOverlay';
import { useToolbarAnchor } from '../text/useToolbarAnchor';

interface ToolbarSize {
  readonly width: number;
  readonly height: number;
}

export interface LatexToolbarOverlayProps {
  readonly element: PPTLatexElement;
  readonly elementIdPrefix?: string;
  readonly editLabel: string;
  readonly onEdit: () => void;
}

export function LatexToolbarOverlay({
  element,
  elementIdPrefix = 'slide-element-',
  editLabel,
  onEdit,
}: LatexToolbarOverlayProps) {
  const anchor = useToolbarAnchor(element.id, elementIdPrefix);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState<ToolbarSize | null>(null);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!anchor || !overlay) {
      setToolbarSize(null);
      return;
    }
    const measure = () => {
      const rect = overlay.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setToolbarSize((current) =>
          current?.width === rect.width && current.height === rect.height
            ? current
            : { width: rect.width, height: rect.height },
        );
      }
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
        'top',
      )
    : null;

  return createPortal(
    <div
      ref={overlayRef}
      className="maic-editing-ui-latex-toolbar"
      data-toolbar-overlay=""
      style={{
        left: position ? `${position.left}px` : '0px',
        position: 'fixed',
        top: position ? `${position.top}px` : '0px',
        visibility: position ? 'visible' : 'hidden',
        zIndex: 'var(--maic-editing-ui-z-index, 80)',
      }}
      role="toolbar"
      aria-label={editLabel}
    >
      <button
        type="button"
        className="maic-editing-ui-icon-button"
        aria-label={editLabel}
        title={editLabel}
        onClick={onEdit}
      >
        <PencilLine aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
