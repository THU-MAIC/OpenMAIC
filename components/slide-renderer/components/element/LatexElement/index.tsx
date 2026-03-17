'use client';

import { useRef, useState, useLayoutEffect } from 'react';
import type { PPTLatexElement } from '@/lib/types/slides';

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
          onMouseDown={handleSelectElement}
          onTouchStart={handleSelectElement}
        >
          {elementInfo.html ? (
            <KatexContent
              html={elementInfo.html}
              width={elementInfo.width}
              height={elementInfo.height}
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

function KatexContent({ html, width, height }: { html: string; width: number; height: number }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    if (!innerRef.current) return;
    const naturalW = innerRef.current.scrollWidth;
    const naturalH = innerRef.current.scrollHeight;
    if (naturalW > 0 && naturalH > 0) {
      setScale(Math.min(width / naturalW, height / naturalH));
    }
  }, [html, width, height]);

  return (
    <div style={{ width, height, overflow: 'hidden' }}>
      <div
        ref={innerRef}
        className="[&_.katex-display]:!m-0"
        style={{
          transformOrigin: '0 0',
          transform: `scale(${scale})`,
          whiteSpace: 'nowrap',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
