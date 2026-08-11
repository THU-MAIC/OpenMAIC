'use client';

import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { BringToFront, SendToBack, Trash2 } from 'lucide-react';
import type { PPTElement } from '@openmaic/dsl';
import { computeToolbarPosition } from '../text/TextToolbarOverlay';
import { useToolbarAnchor } from '../text/useToolbarAnchor';
import type { ElementToolbarLabels } from '../types';

export interface ElementToolbarOverlayProps {
  readonly element: PPTElement;
  readonly elementIdPrefix?: string;
  readonly labels: ElementToolbarLabels;
  readonly onBringToFront?: () => void;
  readonly onSendToBack?: () => void;
  readonly onDelete?: () => void;
  readonly leading?: ReactNode;
}

export function ElementToolbarOverlay({
  element,
  elementIdPrefix = 'slide-element-',
  labels,
  onBringToFront,
  onSendToBack,
  onDelete,
  leading,
}: ElementToolbarOverlayProps) {
  const anchor = useToolbarAnchor(element.id, elementIdPrefix);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const preventFocusLoss = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (!anchor || !toolbar) return;
    const measure = () => {
      const rect = toolbar.getBoundingClientRect();
      if (rect.width && rect.height) setSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(toolbar);
    return () => observer?.disconnect();
  }, [anchor]);
  if (!anchor || typeof document === 'undefined') return null;
  const position = size
    ? computeToolbarPosition(
        anchor,
        size,
        { width: window.innerWidth, height: window.innerHeight },
        'top',
      )
    : null;
  return createPortal(
    <div
      ref={ref}
      className="maic-editing-ui-root maic-editing-ui-element-toolbar"
      role="toolbar"
      aria-label={labels.toolbar}
      data-toolbar-overlay=""
      style={{
        left: position ? `${position.left}px` : '0px',
        position: 'fixed',
        top: position ? `${position.top}px` : '0px',
        visibility: position ? 'visible' : 'hidden',
        zIndex: 'var(--maic-editing-ui-z-index, 80)',
      }}
    >
      {leading}
      {leading && (onBringToFront || onSendToBack || onDelete) ? (
        <span className="maic-editing-ui-divider" aria-hidden="true" />
      ) : null}
      {onBringToFront ? (
        <button
          type="button"
          className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
          aria-label={labels.bringToFront}
          data-tooltip={labels.bringToFront}
          data-tooltip-placement="bottom"
          title={labels.bringToFront}
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
          aria-label={labels.sendToBack}
          data-tooltip={labels.sendToBack}
          data-tooltip-placement="bottom"
          title={labels.sendToBack}
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
            aria-label={labels.delete}
            data-tooltip={labels.delete}
            data-tooltip-placement="bottom"
            title={labels.delete}
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
