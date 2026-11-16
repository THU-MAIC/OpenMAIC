'use client';

import type { PPTLatexElement } from '@openmaic/dsl';
import { KatexContent } from './BaseLatexElement';

export { BaseLatexElement } from './BaseLatexElement';

export interface LatexElementProps {
  elementInfo: PPTLatexElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTLatexElement) => void;
}

/**
 * Latex element component (editable mode).
 * Renders KaTeX HTML if available, falls back to legacy SVG path.
 */
export function LatexElement({ elementInfo, selectElement }: LatexElementProps) {
  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  return (
    <div
      className={`editable-element-latex absolute ${elementInfo.lock ? 'lock' : ''}`}
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
        <div
          className={`element-content relative w-full h-full ${
            elementInfo.lock ? 'cursor-default' : 'cursor-move'
          }`}
          style={{ color: elementInfo.color }}
          onMouseDown={handleSelectElement}
          onTouchStart={handleSelectElement}
        >
          {elementInfo.html ? (
            <KatexContent
              html={elementInfo.html}
              width={elementInfo.width}
              height={elementInfo.height}
              align={elementInfo.align}
            />
          ) : elementInfo.path && elementInfo.viewBox ? (
            <svg
              overflow="visible"
              width={elementInfo.width}
              height={elementInfo.height}
              stroke={elementInfo.color}
              strokeWidth={elementInfo.strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="transform-origin-[0_0]"
            >
              <g
                transform={`scale(${elementInfo.width / elementInfo.viewBox[0]}, ${
                  elementInfo.height / elementInfo.viewBox[1]
                }) translate(0,0) matrix(1,0,0,1,0,0)`}
              >
                <path d={elementInfo.path} />
              </g>
            </svg>
          ) : null}
        </div>
      </div>
    </div>
  );
}
