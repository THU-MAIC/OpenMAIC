'use client';

import type { ChartType } from '@openmaic/dsl';
import { BarChart3, LineChart, PieChart } from 'lucide-react';

export interface ChartInsertPickerOption {
  readonly type: ChartType;
  readonly label: string;
}

export interface ChartInsertPickerProps {
  readonly options: readonly ChartInsertPickerOption[];
  readonly onPick: (chartType: ChartType) => void;
}

function ChartTypeIcon({ type }: { readonly type: ChartType }) {
  if (type === 'pie' || type === 'ring') return <PieChart aria-hidden="true" />;
  if (type === 'line' || type === 'area') return <LineChart aria-hidden="true" />;
  return <BarChart3 aria-hidden="true" />;
}

/** Product-neutral chart type picker with accessible icon actions. */
export function ChartInsertPicker({ options, onPick }: ChartInsertPickerProps) {
  return (
    <div className="maic-editing-ui-chart-picker" role="group">
      {options.map((option) => (
        <button
          key={option.type}
          type="button"
          className="maic-editing-ui-chart-picker-option"
          aria-label={option.label}
          data-tooltip={option.label}
          title={option.label}
          onClick={() => onPick(option.type)}
        >
          <ChartTypeIcon type={option.type} />
        </button>
      ))}
    </div>
  );
}
