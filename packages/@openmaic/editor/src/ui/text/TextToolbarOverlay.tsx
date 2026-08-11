'use client';

import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TextFormatToolbarProps, TextToolbarPlacement } from '../types';
import { TextFormatToolbar } from './TextFormatToolbar';
import { type TrackedToolbarRect, useToolbarAnchor } from './useToolbarAnchor';

const ELEMENT_SPACING = 8;
const VIEWPORT_MARGIN = 12;

interface ToolbarSize {
  readonly width: number;
  readonly height: number;
}

interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface ToolbarPosition {
  readonly left: number;
  readonly top: number;
  readonly side: TextToolbarPlacement;
}

export interface TextToolbarOverlayProps extends TextFormatToolbarProps {
  /** Prefix used by the renderer's SlideElement root IDs. */
  readonly elementIdPrefix?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function computeToolbarPosition(
  anchor: TrackedToolbarRect,
  toolbar: ToolbarSize,
  viewport: ViewportSize,
  placement: TextToolbarPlacement,
): ToolbarPosition {
  const left = clamp(
    anchor.left + anchor.width / 2 - toolbar.width / 2,
    VIEWPORT_MARGIN,
    viewport.width - toolbar.width - VIEWPORT_MARGIN,
  );
  const top = anchor.top - ELEMENT_SPACING - toolbar.height;
  const bottom = anchor.top + anchor.height + ELEMENT_SPACING;
  const topFits = top >= VIEWPORT_MARGIN;
  const bottomFits = bottom + toolbar.height <= viewport.height - VIEWPORT_MARGIN;
  const side =
    placement === 'top'
      ? topFits || !bottomFits
        ? 'top'
        : 'bottom'
      : bottomFits || !topFits
        ? 'bottom'
        : 'top';
  const selectedTop = side === 'top' ? top : bottom;

  return {
    left,
    top: clamp(selectedTop, VIEWPORT_MARGIN, viewport.height - toolbar.height - VIEWPORT_MARGIN),
    side,
  };
}

function equalSizes(left: ToolbarSize | null, right: ToolbarSize) {
  return left?.width === right.width && left.height === right.height;
}

export function TextToolbarOverlay({
  elementId,
  elementIdPrefix = 'slide-element-',
  placement = 'top',
  ...toolbarProps
}: TextToolbarOverlayProps) {
  const anchor = useToolbarAnchor(elementId, elementIdPrefix);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState<ToolbarSize | null>(null);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!anchor || !overlay) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the anchor lifecycle must discard an obsolete DOM measurement.
      setToolbarSize(null);
      return;
    }

    const measure = () => {
      const rect = overlay.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const nextSize = { width: rect.width, height: rect.height };
      setToolbarSize((previous) => (equalSizes(previous, nextSize) ? previous : nextSize));
    };

    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(overlay);
    return () => observer?.disconnect();
  }, [anchor]);

  if (!anchor || typeof document === 'undefined') return null;

  const position = toolbarSize
    ? computeToolbarPosition(
        anchor,
        toolbarSize,
        { width: window.innerWidth, height: window.innerHeight },
        placement,
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
      <TextFormatToolbar elementId={elementId} placement={placement} {...toolbarProps} />
    </div>,
    document.body,
  );
}
