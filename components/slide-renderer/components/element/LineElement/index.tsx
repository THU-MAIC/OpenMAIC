'use client';

import { useMemo } from 'react';
import type { PPTLineElement } from '@/lib/types/slides';
import { getLineElementPath } from '@/lib/utils/element';
import { useElementShadow } from '../hooks/useElementShadow';
import { LinePointMarker } from './LinePointMarker';

export { BaseLineElement } from './BaseLineElement';

export interface LineElementProps {
  elementInfo: PPTLineElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTLineElement) => void;
}

/**
 * Line element component
 * Renders SVG lines with optional arrow/dot endpoints
 */
export function LineElement({ elementInfo, selectElement }: LineElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  // Calculate SVG dimensions
  const svgWidth = useMemo(() => {
    const width = Math.abs(elementInfo.start[0] - elementInfo.end[0]);
    return width < 24 ? 24 : width;
  }, [elementInfo.start, elementInfo.end]);

  const svgHeight = useMemo(() => {
    const height = Math.abs(elementInfo.start[1] - elementInfo.end[1]);
    return height < 24 ? 24 : height;
  }, [elementInfo.start, elementInfo.end]);

  // Calculate line dash array for dashed/dotted styles
  const lineDashArray = useMemo(() => {
    const size = elementInfo.width;
    if (elementInfo.style === 'dashed') {
      return size <= 8 ? `${size * 5} ${size * 2.5}` : `${size * 5} ${size * 1.5}`;
    }
    if (elementInfo.style === 'dotted') {
      return size <= 8 ? `${size * 1.8} ${size * 1.6}` : `${size * 1.5} ${size * 1.2}`;
    }
    return '0 0';
  }, [elementInfo.width, elementInfo.style]);

  // Generate path data
  const path = useMemo(() => {
    return getLineElementPath(elementInfo);
  }, [elementInfo]);

  return (
    <div
      className={`editable-element-line absolute pointer-events-none ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
      }}
    >
      <div
        className="element-content relative w-full h-full"
        style={{
          filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
        }}
        onMouseDown={handleSelectElement}
        onTouchStart={handleSelectElement}
      >
        <svg
          overflow="visible"
          width={svgWidth}
          height={svgHeight}
          className="transform-origin-[0_0]"
        >
          <defs>
            {elementInfo.points[0] && (
              <LinePointMarker
                id={elementInfo.id}
                position="start"
                type={elementInfo.points[0]}
                color={elementInfo.color}
                baseSize={elementInfo.width}
              />
            )}
            {elementInfo.points[1] && (
              <LinePointMarker
                id={elementInfo.id}
                position="end"
                type={elementInfo.points[1]}
                color={elementInfo.color}
                baseSize={elementInfo.width}
              />
            )}
          </defs>
          {/* Visible line */}
          <path
            className={`line-point pointer-events-auto ${elementInfo.lock ? 'cursor-default' : 'cursor-move'}`}
            d={path}
            stroke={elementInfo.color}
            strokeWidth={elementInfo.width}
            strokeDasharray={lineDashArray}
            fill="none"
            markerStart={
              elementInfo.points[0] ? `url(#${elementInfo.id}-${elementInfo.points[0]}-start)` : ''
            }
            markerEnd={
              elementInfo.points[1] ? `url(#${elementInfo.id}-${elementInfo.points[1]}-end)` : ''
            }
          />
          {/* Invisible wider path for easier clicking */}
          <path
            className={`line-path pointer-events-auto ${elementInfo.lock ? 'cursor-default' : 'cursor-move'}`}
            d={path}
            stroke="transparent"
            strokeWidth="20"
            fill="none"
          />
        </svg>
      </div>
    </div>
  );
}
