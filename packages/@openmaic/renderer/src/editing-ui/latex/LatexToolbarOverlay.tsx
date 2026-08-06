'use client';

import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import { BringToFront, PencilLine, SendToBack, Trash2 } from 'lucide-react';
import type { MouseEvent } from 'react';
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
  readonly toolbarLabel: string;
  readonly editLabel: string;
  readonly bringToFrontLabel: string;
  readonly sendToBackLabel: string;
  readonly deleteLabel: string;
  readonly onEdit: () => void;
  readonly onBringToFront?: () => void;
  readonly onSendToBack?: () => void;
  readonly onDelete?: () => void;
}

export function LatexToolbarOverlay({
  element,
  elementIdPrefix = 'slide-element-',
  toolbarLabel,
  editLabel,
  bringToFrontLabel,
  sendToBackLabel,
  deleteLabel,
  onEdit,
  onBringToFront,
  onSendToBack,
  onDelete,
}: LatexToolbarOverlayProps) {
  const anchor = useToolbarAnchor(element.id, elementIdPrefix);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState<ToolbarSize | null>(null);
  const preventFocusLoss = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!anchor || !overlay) return;
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
      className="maic-editing-ui-root maic-editing-ui-latex-toolbar"
      data-toolbar-overlay=""
      style={{
        left: position ? `${position.left}px` : '0px',
        position: 'fixed',
        top: position ? `${position.top}px` : '0px',
        visibility: position ? 'visible' : 'hidden',
        zIndex: 'var(--maic-editing-ui-z-index, 80)',
      }}
      role="toolbar"
      aria-label={toolbarLabel}
    >
      <button
        type="button"
        className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
        aria-label={editLabel}
        data-tooltip={editLabel}
        data-tooltip-placement="bottom"
        title={editLabel}
        onMouseDown={preventFocusLoss}
        onClick={onEdit}
      >
        <PencilLine aria-hidden="true" />
      </button>
      {onBringToFront || onSendToBack || onDelete ? (
        <span className="maic-editing-ui-divider" aria-hidden="true" />
      ) : null}
      {onBringToFront ? (
        <button
          type="button"
          className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
          aria-label={bringToFrontLabel}
          data-tooltip={bringToFrontLabel}
          data-tooltip-placement="bottom"
          title={bringToFrontLabel}
          onMouseDown={preventFocusLoss}
          onClick={onBringToFront}
        >
          <BringToFront aria-hidden="true" />
        </button>
      ) : null}
      {onSendToBack ? (
        <button
          type="button"
          className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
          aria-label={sendToBackLabel}
          data-tooltip={sendToBackLabel}
          data-tooltip-placement="bottom"
          title={sendToBackLabel}
          onMouseDown={preventFocusLoss}
          onClick={onSendToBack}
        >
          <SendToBack aria-hidden="true" />
        </button>
      ) : null}
      {onDelete ? (
        <>
          <span className="maic-editing-ui-divider" aria-hidden="true" />
          <button
            type="button"
            className="maic-editing-ui-icon-button maic-editing-ui-delete-button maic-editing-ui-tooltip-button"
            aria-label={deleteLabel}
            data-tooltip={deleteLabel}
            data-tooltip-placement="bottom"
            title={deleteLabel}
            onMouseDown={preventFocusLoss}
            onClick={onDelete}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
