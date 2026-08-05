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
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { DEFAULT_TEXT_TOOLBAR_FONTS, resolveTextToolbarLabels } from '../labels';
import type { TextFormatToolbarProps, TextToolbarFont } from '../types';
import { DefaultColorPicker } from './DefaultColorPicker';
import { FontSizeControl } from './FontSizeControl';

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
  const colorControlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isColorPickerOpen) return;

    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (colorControlRef.current && !colorControlRef.current.contains(event.target as Node)) {
        setIsColorPickerOpen(false);
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [isColorPickerOpen]);

  const dispatchColorChange = (color: string) => onCommand({ command: 'forecolor', value: color });
  const dispatchColorCommit = (color: string) => {
    dispatchColorChange(color);
    setIsColorPickerOpen(false);
  };

  return (
    <div className={classes} role="toolbar" aria-label={labels.toolbar} data-placement={placement}>
      <div className="maic-editing-ui-group">
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
      <div className="maic-editing-ui-color-control" ref={colorControlRef}>
        <button
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
        {isColorPickerOpen ? (
          <div className="maic-editing-ui-color-popover" role="dialog" aria-label={labels.color}>
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
          </div>
        ) : null}
      </div>
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
      </div>
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
          {onDelete ? (
            <button
              type="button"
              className="maic-editing-ui-icon-button"
              aria-label={labels.delete}
              onMouseDown={preventFocusLoss}
              onClick={onDelete}
            >
              <Trash2 aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
