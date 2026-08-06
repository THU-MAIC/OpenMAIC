'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BringToFront, Pause, Play, Repeat2, SendToBack, Trash2 } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { PPTAudioElement } from '@openmaic/dsl';
import { computeToolbarPosition } from '../text/TextToolbarOverlay';
import { useToolbarAnchor } from '../text/useToolbarAnchor';
import type { AudioEditorLabels } from '../types';

interface ToolbarSize {
  readonly width: number;
  readonly height: number;
}

export interface AudioToolbarOverlayProps {
  readonly element: PPTAudioElement;
  readonly elementIdPrefix?: string;
  readonly labels: AudioEditorLabels;
  readonly onLoopChange: (loop: boolean) => void;
  readonly onBringToFront?: () => void;
  readonly onSendToBack?: () => void;
  readonly onDelete?: () => void;
}

export function AudioToolbarOverlay({
  element,
  elementIdPrefix = 'slide-element-',
  labels,
  onLoopChange,
  onBringToFront,
  onSendToBack,
  onDelete,
}: AudioToolbarOverlayProps) {
  const anchor = useToolbarAnchor(element.id, elementIdPrefix);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const [toolbarSize, setToolbarSize] = useState<ToolbarSize | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const preventFocusLoss = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

  const stopPreview = useCallback(() => {
    previewRef.current?.pause();
    previewRef.current = null;
    setPreviewing(false);
  }, []);

  useEffect(() => stopPreview, [element.id, element.src, stopPreview]);

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

  const togglePreview = async () => {
    if (!element.src) return;
    if (previewing) {
      stopPreview();
      return;
    }
    const preview = new Audio(element.src);
    preview.loop = element.loop;
    preview.onended = stopPreview;
    preview.onerror = stopPreview;
    previewRef.current = preview;
    try {
      await preview.play();
      setPreviewing(true);
    } catch {
      stopPreview();
    }
  };

  if (!anchor || typeof document === 'undefined') return null;
  const position = toolbarSize
    ? computeToolbarPosition(
        anchor,
        toolbarSize,
        { width: window.innerWidth, height: window.innerHeight },
        'top',
      )
    : null;
  const previewLabel = previewing ? labels.pause : labels.preview;

  return createPortal(
    <div
      className="maic-editing-ui-root maic-editing-ui-audio-toolbar-root"
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
        className="maic-editing-ui-audio-toolbar"
        role="toolbar"
        aria-label={labels.toolbar}
      >
        <button
          type="button"
          className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
          aria-label={previewLabel}
          aria-pressed={previewing}
          data-tooltip={previewLabel}
          data-tooltip-placement="bottom"
          disabled={!element.src}
          title={previewLabel}
          onMouseDown={preventFocusLoss}
          onClick={() => void togglePreview()}
        >
          {previewing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="maic-editing-ui-icon-button maic-editing-ui-tooltip-button"
          aria-label={labels.loop}
          aria-pressed={element.loop}
          data-tooltip={labels.loop}
          data-tooltip-placement="bottom"
          title={labels.loop}
          onMouseDown={preventFocusLoss}
          onClick={() => onLoopChange(!element.loop)}
        >
          <Repeat2 aria-hidden="true" />
        </button>
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
    </div>,
    document.body,
  );
}
