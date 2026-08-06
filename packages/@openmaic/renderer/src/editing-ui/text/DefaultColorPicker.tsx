import { Pipette } from 'lucide-react';
import { useEffect, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import type { TextToolbarColorPickerProps } from '../types';

const COMMON_COLOR_SWATCHES = [
  '#000000',
  '#525252',
  '#a3a3a3',
  '#ffffff',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
] as const;

interface EyeDropperInstance {
  open(): Promise<{ sRGBHex: string }>;
}

interface EyeDropperConstructor {
  new (): EyeDropperInstance;
}

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

function getPickerColor(value: string): string {
  return normalizeToolbarColor(value) ?? '#000000';
}

export function DefaultColorPicker({
  value,
  labels,
  onChange,
  onCommit,
}: TextToolbarColorPickerProps) {
  const incomingColor = getPickerColor(value);
  const [color, setColor] = useState(incomingColor);
  const [previousIncomingColor, setPreviousIncomingColor] = useState(incomingColor);
  const [isDragging, setIsDragging] = useState(false);

  if (incomingColor !== previousIncomingColor) {
    setPreviousIncomingColor(incomingColor);
    if (!isDragging) setColor(incomingColor);
  }

  useEffect(() => {
    const stopDragging = () => {
      setIsDragging(false);
    };
    const channels = ['mouseup', 'touchend', 'pointerup', 'pointercancel'] as const;
    channels.forEach((eventName) => window.addEventListener(eventName, stopDragging));
    return () =>
      channels.forEach((eventName) => window.removeEventListener(eventName, stopDragging));
  }, []);

  const handleChange = (nextColor: string) => {
    setIsDragging(true);
    setColor(nextColor);
    onChange(nextColor);
  };

  const handleCommit = (nextColor: string) => {
    setColor(nextColor);
    onCommit(nextColor);
  };

  const EyeDropper = (globalThis as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  const sampleScreen = async () => {
    if (!EyeDropper) return;
    try {
      const result = await new EyeDropper().open();
      handleCommit(result.sRGBHex);
    } catch {
      // Dismissing the system picker should leave the current color unchanged.
    }
  };

  return (
    <div className="maic-editing-ui-color-picker">
      <HexColorPicker color={color} onChange={handleChange} />
      <div className="maic-editing-ui-color-current-row">
        <div className="maic-editing-ui-color-current-value">
          <span
            className="maic-editing-ui-color-current-swatch"
            aria-hidden="true"
            style={{ backgroundColor: color }}
          />
          <span className="maic-editing-ui-color-current-hex">{color}</span>
        </div>
        {EyeDropper ? (
          <button
            type="button"
            className="maic-editing-ui-color-eyedropper"
            aria-label={labels.color}
            onMouseDown={(event) => event.preventDefault()}
            onClick={sampleScreen}
          >
            <Pipette aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div className="maic-editing-ui-color-swatches" role="group" aria-label={labels.color}>
        {COMMON_COLOR_SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="maic-editing-ui-color-swatch"
            aria-label={swatch}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => handleCommit(swatch)}
            style={{ backgroundColor: swatch }}
          />
        ))}
      </div>
    </div>
  );
}
