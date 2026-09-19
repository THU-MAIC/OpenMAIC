'use client';

import type { LinePoint, LineStyleType } from '@openmaic/dsl';

export interface LineInsertPreset {
  readonly path: string;
  readonly style: LineStyleType;
  readonly points: [LinePoint, LinePoint];
  readonly isBroken?: boolean;
  readonly isBroken2?: boolean;
  readonly isCurve?: boolean;
  readonly isCubic?: boolean;
}

export interface LineInsertPickerLabels {
  readonly label: string;
  readonly straight: string;
  readonly dashed: string;
  readonly arrow: string;
  readonly dashedArrow: string;
  readonly dottedEnd: string;
  readonly broken: string;
  readonly doubleBroken: string;
  readonly curve: string;
  readonly cubic: string;
}

export interface LineInsertPickerProps {
  readonly labels?: Partial<LineInsertPickerLabels>;
  readonly onPick: (preset: LineInsertPreset) => void;
}

const DEFAULT_LABELS: LineInsertPickerLabels = {
  label: 'Line presets',
  straight: 'Straight line',
  dashed: 'Dashed line',
  arrow: 'Arrow line',
  dashedArrow: 'Dashed arrow line',
  dottedEnd: 'Dot end line',
  broken: 'Broken line',
  doubleBroken: 'Double broken line',
  curve: 'Curve',
  cubic: 'Cubic curve',
};

const PRESETS: readonly {
  readonly label: keyof Omit<LineInsertPickerLabels, 'label'>;
  readonly preset: LineInsertPreset;
}[] = [
  { label: 'straight', preset: { path: 'M 0 0 L 20 20', style: 'solid', points: ['', ''] } },
  { label: 'dashed', preset: { path: 'M 0 0 L 20 20', style: 'dashed', points: ['', ''] } },
  { label: 'arrow', preset: { path: 'M 0 0 L 20 20', style: 'solid', points: ['', 'arrow'] } },
  {
    label: 'dashedArrow',
    preset: { path: 'M 0 0 L 20 20', style: 'dashed', points: ['', 'arrow'] },
  },
  { label: 'dottedEnd', preset: { path: 'M 0 0 L 20 20', style: 'solid', points: ['', 'dot'] } },
  {
    label: 'broken',
    preset: { path: 'M 0 0 L 0 20 L 20 20', style: 'solid', points: ['', 'arrow'], isBroken: true },
  },
  {
    label: 'doubleBroken',
    preset: {
      path: 'M 0 0 L 10 0 L 10 20 L 20 20',
      style: 'solid',
      points: ['', 'arrow'],
      isBroken2: true,
    },
  },
  {
    label: 'curve',
    preset: { path: 'M 0 0 Q 0 20 20 20', style: 'solid', points: ['', 'arrow'], isCurve: true },
  },
  {
    label: 'cubic',
    preset: {
      path: 'M 0 0 C 20 0 0 20 20 20',
      style: 'solid',
      points: ['', 'arrow'],
      isCubic: true,
    },
  },
];

export function LineInsertPicker({ labels: labelOverrides, onPick }: LineInsertPickerProps) {
  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  return (
    <div className="maic-editing-ui-line-insert-picker" role="group" aria-label={labels.label}>
      {PRESETS.map(({ label, preset }) => (
        <button
          key={label}
          type="button"
          aria-label={labels[label]}
          className="maic-editing-ui-line-insert-option maic-editing-ui-tooltip-button"
          data-tooltip={labels[label]}
          data-tooltip-placement="bottom"
          title={labels[label]}
          onClick={() => onPick(preset)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path
              d={preset.path}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={preset.style === 'dashed' ? '5 2.5' : undefined}
            />
          </svg>
        </button>
      ))}
    </div>
  );
}
