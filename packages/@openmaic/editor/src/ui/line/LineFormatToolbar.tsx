'use client';

import type { LinePoint, LineStyleType, PPTLineElement } from '@openmaic/dsl';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { BringToFront, SendToBack, Trash2 } from 'lucide-react';
import { resolveLineToolbarLabels } from '../labels';
import type { LineFormatToolbarProps, TextToolbarLabels } from '../types';
import { DefaultColorPicker } from '../text/DefaultColorPicker';
import { getLineKind, toLineKindPatch, type LineKind } from './line-format';

const COLOR_POPOVER_WIDTH = 248;
const COLOR_POPOVER_OFFSET = 8;
const VIEWPORT_EDGE_OFFSET = 12;
const useColorPopoverLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const WIDTHS = [1, 2, 3, 4, 6, 8] as const;
const LINE_STYLES: readonly LineStyleType[] = ['solid', 'dashed', 'dotted'];
const LINE_POINTS: readonly LinePoint[] = ['', 'arrow', 'dot'];

export function LineFormatToolbar({
  element,
  onChange,
  locale,
  labels: labelOverrides,
  placement,
  className,
  onBringToFront,
  onSendToBack,
  onDelete,
}: LineFormatToolbarProps) {
  const labels = resolveLineToolbarLabels(locale, labelOverrides);
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [colorPopoverPosition, setColorPopoverPosition] = useState({ left: 0, top: 0 });
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const colorPopoverRef = useRef<HTMLDivElement>(null);
  const emit = (props: Partial<PPTLineElement>) =>
    onChange([{ type: 'element.update', id: element.id, props }]);
  const preventFocusLoss = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

  useEffect(() => {
    if (!isColorPickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!colorButtonRef.current?.contains(target) && !colorPopoverRef.current?.contains(target)) {
        setIsColorPickerOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [isColorPickerOpen]);

  useColorPopoverLayoutEffect(() => {
    if (!isColorPickerOpen) return;
    const updatePosition = () => {
      const rect = colorButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const minLeft = VIEWPORT_EDGE_OFFSET;
      const maxLeft = Math.max(
        minLeft,
        window.innerWidth - COLOR_POPOVER_WIDTH - VIEWPORT_EDGE_OFFSET,
      );
      setColorPopoverPosition({
        left: Math.min(
          Math.max(rect.left + rect.width / 2 - COLOR_POPOVER_WIDTH / 2, minLeft),
          maxLeft,
        ),
        top: rect.bottom + COLOR_POPOVER_OFFSET,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
    };
  }, [isColorPickerOpen]);

  const currentKind = getLineKind(element);
  const colorPickerLabels = { color: labels.color } as TextToolbarLabels;
  const pointLabel = (point: LinePoint) =>
    point === 'arrow' ? labels.arrow : point === 'dot' ? labels.dot : labels.none;

  return (
    <div
      className={['maic-editing-ui-root', 'maic-editing-ui-line-toolbar', className]
        .filter(Boolean)
        .join(' ')}
      role="toolbar"
      aria-label={labels.toolbar}
      data-placement={placement}
    >
      <select
        className="maic-editing-ui-select maic-editing-ui-line-select"
        aria-label={labels.kind}
        value={currentKind}
        onChange={(event) => emit(toLineKindPatch(element, event.target.value as LineKind))}
      >
        <option value="straight">{labels.straight}</option>
        <option value="broken">{labels.broken}</option>
        <option value="broken2">{labels.broken2}</option>
        <option value="curve">{labels.curve}</option>
        <option value="cubic">{labels.cubic}</option>
      </select>
      <button
        ref={colorButtonRef}
        type="button"
        className="maic-editing-ui-icon-button maic-editing-ui-color-button"
        aria-label={labels.color}
        aria-expanded={isColorPickerOpen}
        aria-haspopup="dialog"
        onMouseDown={preventFocusLoss}
        onClick={() => setIsColorPickerOpen((open) => !open)}
      >
        <span
          className="maic-editing-ui-color-button-preview"
          aria-hidden="true"
          style={{ backgroundColor: element.color }}
        />
      </button>
      <select
        className="maic-editing-ui-select maic-editing-ui-line-width-select"
        aria-label={labels.width}
        value={element.width}
        onChange={(event) => emit({ width: Number(event.target.value) })}
      >
        {WIDTHS.map((width) => (
          <option key={width} value={width}>
            {width}px
          </option>
        ))}
      </select>
      <select
        className="maic-editing-ui-select maic-editing-ui-line-select"
        aria-label={labels.style}
        value={element.style}
        onChange={(event) => emit({ style: event.target.value as LineStyleType })}
      >
        {LINE_STYLES.map((style) => (
          <option key={style} value={style}>
            {labels[style]}
          </option>
        ))}
      </select>
      {(['start', 'end'] as const).map((position, index) => (
        <select
          key={position}
          className="maic-editing-ui-select maic-editing-ui-line-marker-select"
          aria-label={position === 'start' ? labels.start : labels.end}
          value={element.points[index]}
          onChange={(event) => {
            const points: [LinePoint, LinePoint] = [...element.points] as [LinePoint, LinePoint];
            points[index] = event.target.value as LinePoint;
            emit({ points });
          }}
        >
          {LINE_POINTS.map((point) => (
            <option key={point || 'none'} value={point}>
              {pointLabel(point)}
            </option>
          ))}
        </select>
      ))}
      {onBringToFront || onSendToBack || onDelete ? (
        <>
          <div className="maic-editing-ui-divider" aria-hidden="true" />
          {onBringToFront ? (
            <button
              type="button"
              className="maic-editing-ui-icon-button"
              aria-label={labels.bringToFront}
              onMouseDown={preventFocusLoss}
              onClick={onBringToFront}
            >
              <BringToFront aria-hidden="true" />
            </button>
          ) : null}
          {onSendToBack ? (
            <button
              type="button"
              className="maic-editing-ui-icon-button"
              aria-label={labels.sendToBack}
              onMouseDown={preventFocusLoss}
              onClick={onSendToBack}
            >
              <SendToBack aria-hidden="true" />
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              className="maic-editing-ui-icon-button maic-editing-ui-delete-button"
              aria-label={labels.delete}
              onMouseDown={preventFocusLoss}
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" />
            </button>
          ) : null}
        </>
      ) : null}
      {isColorPickerOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={colorPopoverRef}
              className="maic-editing-ui-root maic-editing-ui-color-popover maic-editing-ui-color-popover-overlay"
              role="dialog"
              aria-label={labels.color}
              style={colorPopoverPosition}
            >
              <DefaultColorPicker
                value={element.color}
                labels={colorPickerLabels}
                onChange={() => {}}
                onCommit={(color) => {
                  emit({ color });
                  setIsColorPickerOpen(false);
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
