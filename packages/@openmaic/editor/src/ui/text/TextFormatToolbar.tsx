'use client';

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  BringToFront,
  Italic,
  List,
  SendToBack,
  Trash2,
  Underline,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_TEXT_TOOLBAR_FONTS, resolveTextToolbarLabels } from '../labels';
import type { TextFormatToolbarProps, TextToolbarFont } from '../types';
import { DefaultColorPicker } from './DefaultColorPicker';
import { FontSizeControl } from './FontSizeControl';

const COLOR_POPOVER_WIDTH = 248;
const COLOR_POPOVER_OFFSET = 8;
const VIEWPORT_EDGE_OFFSET = 12;
const useColorPopoverLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function Divider() {
  return <div className="maic-editing-ui-divider" aria-hidden="true" />;
}

export function TextFormatToolbar({
  format,
  onCommand,
  onBringToFront,
  onSendToBack,
  onDelete,
  className,
  fonts = DEFAULT_TEXT_TOOLBAR_FONTS,
  locale,
  labels: labelOverrides,
  placement,
  renderColorPicker,
}: TextFormatToolbarProps) {
  const labels = resolveTextToolbarLabels(locale, labelOverrides);
  const hasCurrentFont = fonts.some((font) => font.value === format.fontname);
  const fontOptions: readonly TextToolbarFont[] = hasCurrentFont
    ? fonts
    : [{ label: format.fontname || labels.fontDefault, value: format.fontname }, ...fonts];
  const classes = ['maic-editing-ui-root', 'maic-editing-ui-text-toolbar', className]
    .filter(Boolean)
    .join(' ');
  const preventFocusLoss = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [colorPopoverPosition, setColorPopoverPosition] = useState({ left: 0, top: 0 });
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const colorPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isColorPickerOpen) return;

    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const isInsideColorPicker =
        colorButtonRef.current?.contains(target) || colorPopoverRef.current?.contains(target);

      if (!isInsideColorPicker) {
        setIsColorPickerOpen(false);
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [isColorPickerOpen]);

  useColorPopoverLayoutEffect(() => {
    if (!isColorPickerOpen) return;

    const updateColorPopoverPosition = () => {
      const button = colorButtonRef.current;
      if (!button) return;

      const buttonRect = button.getBoundingClientRect();
      const minimumLeft = VIEWPORT_EDGE_OFFSET;
      const maximumLeft = Math.max(
        minimumLeft,
        window.innerWidth - COLOR_POPOVER_WIDTH - VIEWPORT_EDGE_OFFSET,
      );
      const centeredLeft = buttonRect.left + buttonRect.width / 2 - COLOR_POPOVER_WIDTH / 2;

      setColorPopoverPosition({
        left: Math.min(Math.max(centeredLeft, minimumLeft), maximumLeft),
        top: buttonRect.bottom + COLOR_POPOVER_OFFSET,
      });
    };

    updateColorPopoverPosition();
    window.addEventListener('resize', updateColorPopoverPosition);
    document.addEventListener('scroll', updateColorPopoverPosition, true);

    return () => {
      window.removeEventListener('resize', updateColorPopoverPosition);
      document.removeEventListener('scroll', updateColorPopoverPosition, true);
    };
  }, [isColorPickerOpen]);

  const dispatchColorChange = (color: string) => onCommand({ command: 'forecolor', value: color });
  const dispatchColorCommit = (color: string) => {
    dispatchColorChange(color);
    setIsColorPickerOpen(false);
  };
  return (
    <div className={classes} role="toolbar" aria-label={labels.toolbar} data-placement={placement}>
      <div className="maic-editing-ui-group maic-editing-ui-font-group">
        <select
          className="maic-editing-ui-select"
          aria-label={labels.font}
          value={format.fontname}
          onChange={(event) => onCommand({ command: 'fontname', value: event.target.value })}
        >
          {fontOptions.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>
      </div>
      <FontSizeControl value={format.fontsize} labels={labels} onCommand={onCommand} />
      <Divider />
      <div className="maic-editing-ui-group">
        <button
          type="button"
          className="maic-editing-ui-icon-button"
          aria-label={labels.bold}
          aria-pressed={format.bold}
          onMouseDown={preventFocusLoss}
          onClick={() => onCommand({ command: 'bold' })}
        >
          <Bold aria-hidden />
        </button>
        <button
          type="button"
          className="maic-editing-ui-icon-button"
          aria-label={labels.italic}
          aria-pressed={format.em}
          onMouseDown={preventFocusLoss}
          onClick={() => onCommand({ command: 'em' })}
        >
          <Italic aria-hidden />
        </button>
        <button
          type="button"
          className="maic-editing-ui-icon-button"
          aria-label={labels.underline}
          aria-pressed={format.underline}
          onMouseDown={preventFocusLoss}
          onClick={() => onCommand({ command: 'underline' })}
        >
          <Underline aria-hidden />
        </button>
        <div className="maic-editing-ui-color-control">
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
              style={{ backgroundColor: format.color || '#000000' }}
            />
          </button>
        </div>
      </div>
      <Divider />
      <div className="maic-editing-ui-group">
        <button
          type="button"
          className="maic-editing-ui-icon-button"
          aria-label={labels.alignLeft}
          aria-pressed={format.align === 'left'}
          onMouseDown={preventFocusLoss}
          onClick={() => onCommand({ command: 'align', value: 'left' })}
        >
          <AlignLeft aria-hidden />
        </button>
        <button
          type="button"
          className="maic-editing-ui-icon-button"
          aria-label={labels.alignCenter}
          aria-pressed={format.align === 'center'}
          onMouseDown={preventFocusLoss}
          onClick={() => onCommand({ command: 'align', value: 'center' })}
        >
          <AlignCenter aria-hidden />
        </button>
        <button
          type="button"
          className="maic-editing-ui-icon-button"
          aria-label={labels.alignRight}
          aria-pressed={format.align === 'right'}
          onMouseDown={preventFocusLoss}
          onClick={() => onCommand({ command: 'align', value: 'right' })}
        >
          <AlignRight aria-hidden />
        </button>
        <button
          type="button"
          className="maic-editing-ui-icon-button"
          aria-label={labels.bullet}
          aria-pressed={format.bulletList}
          onMouseDown={preventFocusLoss}
          onClick={() => onCommand({ command: 'bulletList' })}
        >
          <List aria-hidden />
        </button>
      </div>
      {onBringToFront || onSendToBack || onDelete ? (
        <>
          <Divider />
          {(onBringToFront || onSendToBack) && (
            <div className="maic-editing-ui-group">
              {onBringToFront ? (
                <button
                  type="button"
                  className="maic-editing-ui-icon-button"
                  aria-label={labels.bringToFront}
                  onMouseDown={preventFocusLoss}
                  onClick={onBringToFront}
                >
                  <BringToFront aria-hidden />
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
                  <SendToBack aria-hidden />
                </button>
              ) : null}
            </div>
          )}
          {onDelete ? <Divider /> : null}
          {onDelete ? (
            <button
              type="button"
              className="maic-editing-ui-icon-button maic-editing-ui-delete-button"
              aria-label={labels.delete}
              onMouseDown={preventFocusLoss}
              onClick={onDelete}
            >
              <Trash2 aria-hidden />
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
              {renderColorPicker ? (
                renderColorPicker({
                  value: format.color,
                  labels,
                  onChange: dispatchColorChange,
                  onCommit: dispatchColorCommit,
                })
              ) : (
                <DefaultColorPicker
                  value={format.color}
                  labels={labels}
                  onChange={dispatchColorChange}
                  onCommit={dispatchColorCommit}
                />
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
