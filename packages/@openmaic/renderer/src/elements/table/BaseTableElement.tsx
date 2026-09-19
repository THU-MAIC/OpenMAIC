'use client';

import type { ReactNode } from 'react';
import type { PPTTableElement } from '@openmaic/dsl';
import { StaticTable } from './StaticTable';

export interface BaseTableElementProps {
  elementInfo: PPTTableElement;
  target?: string;
  renderContent?: (element: PPTTableElement, defaultContent: ReactNode) => ReactNode;
}

export function BaseTableElement({ elementInfo, target, renderContent }: BaseTableElementProps) {
  const defaultContent = <StaticTable elementInfo={elementInfo} />;
  return (
    <div
      className="base-element-table"
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
        <div className="element-content" style={{ width: '100%', height: '100%' }}>
          {renderContent?.(elementInfo, defaultContent) ?? defaultContent}
        </div>
      </div>
    </div>
  );
}
