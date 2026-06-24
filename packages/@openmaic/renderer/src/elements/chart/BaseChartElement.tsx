'use client';

import type { PPTChartElement } from '@openmaic/dsl';
import { ElementOutline } from '../shared/ElementOutline';
import { Chart } from './Chart';

export interface BaseChartElementProps {
  elementInfo: PPTChartElement;
  target?: string;
}

export function BaseChartElement({ elementInfo, target }: BaseChartElementProps) {
  return (
    <div
      className="base-element-chart"
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
        pointerEvents: target === 'thumbnail' ? 'none' : undefined,
      }}
    >
      <div
        className="rotate-wrapper"
        style={{
          width: '100%',
          height: '100%',
          transform: `rotate(${elementInfo.rotate}deg)`,
        }}
      >
        <div
          className="element-content"
          style={{ width: '100%', height: '100%', backgroundColor: elementInfo.fill }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <Chart
            width={elementInfo.width}
            height={elementInfo.height}
            type={elementInfo.chartType}
            data={elementInfo.data}
            themeColors={elementInfo.themeColors}
            textColor={elementInfo.textColor}
            lineColor={elementInfo.lineColor}
            options={elementInfo.options}
          />
        </div>
      </div>
    </div>
  );
}
