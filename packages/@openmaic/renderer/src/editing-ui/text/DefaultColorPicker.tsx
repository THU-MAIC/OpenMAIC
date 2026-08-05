import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { TextToolbarColorPickerProps } from '../types';

interface ToolbarColorSwatch {
  readonly value: string;
}

const COMMON_COLOR_SWATCHES: readonly ToolbarColorSwatch[] = [
  { value: '#000000' },
  { value: '#ef4444' },
  { value: '#f97316' },
  { value: '#eab308' },
  { value: '#22c55e' },
  { value: '#3b82f6' },
  { value: '#a855f7' },
  { value: '#ffffff' },
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
  const openingColor = getPreviewColor(value);
  const openingColorRef = useRef(openingColor);
  const previewColorRef = useRef(openingColor);
  const lastCommittedColorRef = useRef<string | null>(null);
  const pendingSwatchClickRef = useRef(false);
  const pendingNativeInteractionRef = useRef(false);
  const nativeInputRef = useRef<HTMLInputElement>(null);

  const clearNativeInteraction = () => {
    pendingNativeInteractionRef.current = false;
  };

  useEffect(() => {
    setDraft(incomingValue);
  }, [incomingValue]);

  useEffect(() => {
    const nativeInput = nativeInputRef.current;
    if (!nativeInput) return clearNativeInteraction;
    nativeInput.addEventListener('cancel', clearNativeInteraction);
    return () => {
      nativeInput.removeEventListener('cancel', clearNativeInteraction);
      clearNativeInteraction();
    };
  }, []);

  const commitColor = (color: string) => {
    if (lastCommittedColorRef.current === color) return;
    lastCommittedColorRef.current = color;
    onCommit(color);
  };

  const previewColor = (color: string) => {
    if (previewColorRef.current !== color) lastCommittedColorRef.current = null;
    previewColorRef.current = color;
    onChange(color);
  };

  const commitDraft = () => {
    const normalized = normalizeToolbarColor(draft);
    if (!normalized) return;
    setDraft(normalized);
    commitColor(normalized);
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
    if (pendingNativeInteractionRef.current) return;
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
    commitColor(color);
  };

  const handleNativeColorChange = (event: ChangeEvent<HTMLInputElement>) => {
    pendingNativeInteractionRef.current = false;
    const normalized = normalizeToolbarColor(event.target.value);
    if (!normalized) return;
    setDraft(normalized);
    previewColor(normalized);
    commitColor(normalized);
  };

  const handleNativePointerDown = (_event: PointerEvent<HTMLInputElement>) => {
    pendingNativeInteractionRef.current = true;
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
            aria-label={`${labels.color} ${swatch.value}`}
            title={`${labels.color} ${swatch.value}`}
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
          ref={nativeInputRef}
          onPointerDown={handleNativePointerDown}
          onChange={handleNativeColorChange}
          onBlur={clearNativeInteraction}
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
