'use client';

import type { PPTTableElement } from '@/lib/types/slides';
import { StaticTable } from './StaticTable';

export interface BaseTableElementProps {
  elementInfo: PPTTableElement;
  target?: string;
}

/**
 * Base table element for read-only / playback / thumbnail mode
 */
export function BaseTableElement({ elementInfo, target }: BaseTableElementProps) {
  return (
    <div
      className={`base-element-table absolute ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div className="element-content w-full h-full">
          <StaticTable elementInfo={elementInfo} />
        </div>
      </div>
    </div>
  );
}
