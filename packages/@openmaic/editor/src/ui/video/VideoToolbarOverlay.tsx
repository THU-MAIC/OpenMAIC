'use client';

import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BringToFront, ImagePlus, SendToBack, Trash2 } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { PPTVideoElement } from '@openmaic/dsl';
import { computeToolbarPosition } from '../text/TextToolbarOverlay';
import { useToolbarAnchor } from '../text/useToolbarAnchor';
import type { VideoEditorLabels, VideoPosterPickerRenderer } from '../types';

interface ToolbarSize {
  readonly width: number;
  readonly height: number;
}

export interface VideoToolbarOverlayProps {
  readonly element: PPTVideoElement;
  readonly elementIdPrefix?: string;
  readonly labels: VideoEditorLabels;
  readonly renderPosterPicker?: VideoPosterPickerRenderer;
  readonly onPosterChange: (poster: string) => void;
  readonly onBringToFront?: () => void;
  readonly onSendToBack?: () => void;
  readonly onDelete?: () => void;
}

export function VideoToolbarOverlay({
  element,
  elementIdPrefix = 'slide-element-',
  labels,
  renderPosterPicker,
  onPosterChange,
  onBringToFront,
  onSendToBack,
  onDelete,
}: VideoToolbarOverlayProps) {
  const anchor = useToolbarAnchor(element.id, elementIdPrefix);
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarSize, setToolbarSize] = useState<ToolbarSize | null>(null);
  const [posterPickerOpen, setPosterPickerOpen] = useState(false);
  const preventFocusLoss = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!anchor || !toolbar) return;
    const measure = () => {
      const rect = toolbar.getBoundingClientRect();
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
    observer?.observe(toolbar);
    return () => observer?.disconnect();
  }, [anchor]);

  useEffect(() => {
    if (!posterPickerOpen) return;
    const closeWhenOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPosterPickerOpen(false);
    };
    const closeWhenEscaped = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPosterPickerOpen(false);
    };
    document.addEventListener('pointerdown', closeWhenOutside);
    document.addEventListener('keydown', closeWhenEscaped);
    return () => {
      document.removeEventListener('pointerdown', closeWhenOutside);
      document.removeEventListener('keydown', closeWhenEscaped);
    };
  }, [posterPickerOpen]);

  if (!anchor || typeof document === 'undefined') return null;
  const position = toolbarSize
    ? computeToolbarPosition(
        anchor,
        toolbarSize,
        { width: window.innerWidth, height: window.innerHeight },
        'top',
      )
    : null;
  const showPosterPicker = posterPickerOpen && renderPosterPicker;

  return createPortal(
    <div
      ref={rootRef}
      className="maic-editing-ui-root maic-editing-ui-video-toolbar-root"
      data-toolbar-overlay=""
      style={{
        left: position ? `${position.left}px` : '0px',
        position: 'fixed',
        top: position ? `${position.top}px` : '0px',
        visibility: position ? 'visible' : 'hidden',
        zIndex: 'var(--maic-editing-ui-z-index, 80)',
      }}
    >
      <div
        ref={toolbarRef}
        className="maic-editing-ui-video-toolbar"
        role="toolbar"
        aria-label={labels.toolbar}
      >
        {renderPosterPicker ? (
          <button
            type="button"
            className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
            aria-label={labels.poster}
            aria-pressed={posterPickerOpen}
            data-tooltip={labels.poster}
            data-tooltip-placement="bottom"
            title={labels.poster}
            onMouseDown={preventFocusLoss}
            onClick={() => setPosterPickerOpen((current) => !current)}
          >
            <ImagePlus aria-hidden="true" />
          </button>
        ) : null}
        {onBringToFront || onSendToBack || onDelete ? (
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
      </div>
      {showPosterPicker ? (
        <div
          className="maic-editing-ui-video-poster-popover"
          role="dialog"
          aria-label={labels.poster}
        >
          {renderPosterPicker({
            element,
            onPick: (poster) => {
              onPosterChange(poster);
              setPosterPickerOpen(false);
            },
            close: () => setPosterPickerOpen(false),
          })}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
