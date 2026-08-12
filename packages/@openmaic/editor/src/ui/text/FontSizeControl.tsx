'use client';

import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { TextEditCommand } from '../../react/text/types';
import type { TextToolbarLabels } from '../types';

export const TEXT_TOOLBAR_FONT_SIZE_MIN = 8;
export const TEXT_TOOLBAR_FONT_SIZE_MAX = 96;

function parseTextToolbarFontSize(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 16 : parsed;
}

export function stepTextToolbarFontSize(current: string, delta: number): string {
  const value = parseTextToolbarFontSize(current);
  return `${Math.max(TEXT_TOOLBAR_FONT_SIZE_MIN, Math.min(TEXT_TOOLBAR_FONT_SIZE_MAX, value + delta))}px`;
}

interface FontSizeControlProps {
  readonly value: string;
  readonly labels: TextToolbarLabels;
  readonly onCommand: (command: TextEditCommand) => void;
}

function normalizeTextToolbarFontSize(value: string): string {
  return stepTextToolbarFontSize(value, 0);
}

export function FontSizeControl({ value, labels, onCommand }: FontSizeControlProps) {
  const [inputValue, setInputValue] = useState(() => String(parseTextToolbarFontSize(value)));

  useEffect(() => {
    setInputValue(String(parseTextToolbarFontSize(value)));
  }, [value]);

  const commit = () => {
    const nextValue = normalizeTextToolbarFontSize(inputValue);
    setInputValue(String(parseTextToolbarFontSize(nextValue)));
    if (nextValue !== value) {
      onCommand({ command: 'fontsize', value: nextValue });
    }
  };

  const step = (delta: number) => {
    const nextValue = stepTextToolbarFontSize(value, delta);
    if (nextValue !== value) {
      onCommand({ command: 'fontsize', value: nextValue });
    }
  };

  return (
    <div className="maic-editing-ui-font-size-stepper" role="group" aria-label={labels.fontSize}>
      <button
        type="button"
        className="maic-editing-ui-step-button"
        aria-label={labels.sizeDown}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => step(-2)}
      >
        <Minus aria-hidden />
      </button>
      <input
        type="text"
        inputMode="numeric"
        role="spinbutton"
        className="maic-editing-ui-font-size-input"
        aria-label={labels.fontSize}
        value={inputValue}
        onChange={(event) => setInputValue(event.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setInputValue(String(parseTextToolbarFontSize(value)));
          }
        }}
      />
      <button
        type="button"
        className="maic-editing-ui-step-button"
        aria-label={labels.sizeUp}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => step(2)}
      >
        <Plus aria-hidden />
      </button>
    </div>
  );
}
