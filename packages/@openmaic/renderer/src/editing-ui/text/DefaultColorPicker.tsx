import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent } from 'react';
import type { TextToolbarColorPickerProps } from '../types';

interface ToolbarColorSwatch {
  readonly name: string;
  readonly value: string;
}

const COMMON_COLOR_SWATCHES: readonly ToolbarColorSwatch[] = [
  { name: 'Black', value: '#000000' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'White', value: '#ffffff' },
];

export function normalizeToolbarColor(value: string): string | null {
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(input)) return input;
  if (/^#[0-9a-f]{3}$/.test(input)) {
    return `#${input
      .slice(1)
      .split('')
      .map((char) => char + char)
      .join('')}`;
  }
  return null;
}

function getDraftValue(value: string): string {
  return normalizeToolbarColor(value) ?? value.trim().toLowerCase();
}

function getPreviewColor(value: string): string {
  return normalizeToolbarColor(value) ?? '#000000';
}

export function DefaultColorPicker({
  value,
  labels,
  onChange,
  onCommit,
}: TextToolbarColorPickerProps) {
  const [draft, setDraft] = useState(() => getDraftValue(value));
  const incomingValue = getDraftValue(value);
  const openingColorRef = useRef(getPreviewColor(value));
  const previewColorRef = useRef(openingColorRef.current);
  const pendingSwatchClickRef = useRef(false);

  useEffect(() => {
    setDraft(incomingValue);
  }, [incomingValue]);

  const commitDraft = () => {
    const normalized = normalizeToolbarColor(draft);
    if (!normalized) return;
    setDraft(normalized);
    onCommit(normalized);
  };

  const previewColor = (color: string) => {
    previewColorRef.current = color;
    onChange(color);
  };

  const handleTextChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextDraft = event.target.value;
    setDraft(nextDraft);
    const normalized = normalizeToolbarColor(nextDraft);
    if (normalized) previewColor(normalized);
  };

  const handleTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const openingColor = openingColorRef.current;
      setDraft(openingColor);
      if (previewColorRef.current !== openingColor) previewColor(openingColor);
    }
  };

  const handleTextBlur = () => {
    if (pendingSwatchClickRef.current) {
      pendingSwatchClickRef.current = false;
      return;
    }
    commitDraft();
  };

  const handleSwatchMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    pendingSwatchClickRef.current = true;
  };

  const selectSwatch = (color: string) => {
    pendingSwatchClickRef.current = false;
    setDraft(color);
    previewColor(color);
    onCommit(color);
  };

  const handleNativeColorChange = (event: ChangeEvent<HTMLInputElement>) => {
    const normalized = normalizeToolbarColor(event.target.value);
    if (!normalized) return;
    setDraft(normalized);
    previewColor(normalized);
  };

  return (
    <div className="maic-editing-ui-color-picker">
      <div className="maic-editing-ui-color-picker-preview" aria-hidden="true">
        <span style={{ backgroundColor: getPreviewColor(draft) }} />
      </div>
      <div className="maic-editing-ui-color-swatches" role="group" aria-label={labels.color}>
        {COMMON_COLOR_SWATCHES.map((swatch) => (
          <button
            key={swatch.value}
            type="button"
            className="maic-editing-ui-color-swatch"
            aria-label={swatch.name}
            title={swatch.name}
            style={{ backgroundColor: swatch.value }}
            onMouseDown={handleSwatchMouseDown}
            onClick={() => selectSwatch(swatch.value)}
          />
        ))}
      </div>
      <div className="maic-editing-ui-color-input-row">
        <input
          type="color"
          className="maic-editing-ui-color-native-input"
          aria-label={labels.color}
          value={getPreviewColor(draft)}
          onChange={handleNativeColorChange}
        />
        <input
          type="text"
          className="maic-editing-ui-color-hex-input"
          aria-label={labels.colorHex}
          value={draft}
          onChange={handleTextChange}
          onBlur={handleTextBlur}
          onKeyDown={handleTextKeyDown}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
