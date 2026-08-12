'use client';

import { useState, type ReactNode } from 'react';
import type { SlideBackground } from '@openmaic/dsl';

export interface BackgroundInsertPickerLabels {
  readonly solid: string;
  readonly image: string;
  readonly color: string;
}

export interface BackgroundInsertPickerProps {
  readonly background?: SlideBackground;
  readonly labels?: Partial<BackgroundInsertPickerLabels>;
  readonly renderImagePicker?: (onPick: (src: string) => void) => ReactNode;
  readonly onChange: (background: SlideBackground) => void;
}

const DEFAULT_LABELS: BackgroundInsertPickerLabels = {
  solid: 'Solid',
  image: 'Image',
  color: 'Background color',
};

function isColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function BackgroundInsertPicker({
  background,
  labels: labelOverrides,
  renderImagePicker,
  onChange,
}: BackgroundInsertPickerProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const [tab, setTab] = useState(background?.type === 'image' ? 'image' : 'solid');
  const [color, setColor] = useState(
    background?.type === 'solid' && background.color ? background.color : '#ffffff',
  );
  const backgroundType = background?.type ?? 'solid';
  const backgroundColor = background?.type === 'solid' ? background.color : undefined;
  const [syncedBackground, setSyncedBackground] = useState({
    type: backgroundType,
    color: backgroundColor,
  });

  if (backgroundType !== syncedBackground.type || backgroundColor !== syncedBackground.color) {
    setSyncedBackground({ type: backgroundType, color: backgroundColor });
    if (backgroundType === 'image') setTab('image');
    if (backgroundColor) setColor(backgroundColor);
  }

  const applyColor = (nextColor: string) => {
    setColor(nextColor);
    if (isColor(nextColor)) onChange({ type: 'solid', color: nextColor });
  };

  return (
    <div className="maic-editing-ui-background-picker">
      <div className="maic-editing-ui-background-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'solid'}
          className="maic-editing-ui-background-tab"
          data-active={tab === 'solid' || undefined}
          onClick={() => setTab('solid')}
        >
          {labels.solid}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'image'}
          className="maic-editing-ui-background-tab"
          data-active={tab === 'image' || undefined}
          onClick={() => setTab('image')}
        >
          {labels.image}
        </button>
      </div>
      {tab === 'solid' ? (
        <label className="maic-editing-ui-background-color-field">
          <span>{labels.color}</span>
          <span className="maic-editing-ui-background-color-inputs">
            <input
              type="color"
              aria-label={labels.color}
              value={isColor(color) ? color : '#ffffff'}
              onChange={(event) => applyColor(event.target.value)}
            />
            <input
              type="text"
              value={color}
              spellCheck={false}
              aria-label={`${labels.color} hex`}
              onChange={(event) => setColor(event.target.value)}
              onBlur={() => applyColor(color)}
            />
          </span>
        </label>
      ) : (
        <div className="maic-editing-ui-background-image-picker">
          {renderImagePicker?.((src) => onChange({ type: 'image', image: { src, size: 'cover' } }))}
        </div>
      )}
    </div>
  );
}
