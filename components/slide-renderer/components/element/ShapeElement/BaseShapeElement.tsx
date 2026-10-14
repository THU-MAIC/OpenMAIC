'use client';

import { useMemo, useRef } from 'react';
import type { PPTShapeElement, ShapeText } from '@openmaic/dsl';
import { validateShapeGeometry, RENDER_PATH_LIMITS } from '@openmaic/geometry';
import { useInlineMath, useInnerHtml } from '@openmaic/renderer';
import { useElementOutline } from '../hooks/useElementOutline';
import { useElementShadow } from '../hooks/useElementShadow';
import { useElementFlip } from '../hooks/useElementFlip';
import { useElementFill } from '../hooks/useElementFill';
import { GradientDefs } from './GradientDefs';
import { PatternDefs } from './PatternDefs';

export interface BaseShapeElementProps {
  elementInfo: PPTShapeElement;
}

/**
 * Base shape element for read-only/playback mode
 */
export function BaseShapeElement({ elementInfo }: BaseShapeElementProps) {
  const geometry = useMemo(
    () =>
      validateShapeGeometry(
        {
          path: elementInfo.path,
          viewBox: elementInfo.viewBox,
          width: elementInfo.width,
          height: elementInfo.height,
        },
        RENDER_PATH_LIMITS,
      ),
    [elementInfo.path, elementInfo.viewBox, elementInfo.width, elementInfo.height],
  );
  // Keep the label's viewport usable even when old records contain bad sizes.
  const width =
    Number.isFinite(elementInfo.width) && elementInfo.width > 0
      ? geometry.ok
        ? elementInfo.width
        : Math.min(elementInfo.width, 4000)
      : 100;
  const height =
    Number.isFinite(elementInfo.height) && elementInfo.height > 0
      ? geometry.ok
        ? elementInfo.height
        : Math.min(elementInfo.height, 4000)
      : 100;
  const { fill } = useElementFill(elementInfo, 'base');
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(elementInfo.outline);
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);

  const text: ShapeText = elementInfo.text || {
    content: '',
    align: 'middle',
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
  };

  const proseRef = useRef<HTMLDivElement>(null);
  const innerHtml = useInnerHtml(text.content);
  useInlineMath(proseRef, text.content);

  return (
    <div
      className="base-element-shape absolute"
      data-shape-geometry-error={geometry.ok ? undefined : geometry.error.code}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${width}px`,
        height: `${height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          className="element-content relative w-full h-full"
          style={{
            opacity: elementInfo.opacity,
            filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
            transform: flipStyle,
            color: text.defaultColor,
            fontFamily: text.defaultFontName,
          }}
        >
          <svg
            overflow="visible"
            width={width}
            height={height}
            className="transform-origin-[0_0] overflow-visible block"
          >
            <defs>
              {elementInfo.pattern && (
                <PatternDefs id={`base-pattern-${elementInfo.id}`} src={elementInfo.pattern} />
              )}
              {elementInfo.gradient && (
                <GradientDefs
                  id={`base-gradient-${elementInfo.id}`}
                  type={elementInfo.gradient.type}
                  colors={elementInfo.gradient.colors}
                  rotate={elementInfo.gradient.rotate}
                />
              )}
            </defs>
            <g
              transform={`scale(${geometry.ok ? elementInfo.width / elementInfo.viewBox[0] : 1}, ${
                geometry.ok ? elementInfo.height / elementInfo.viewBox[1] : 1
              }) translate(0,0) matrix(1,0,0,1,0,0)`}
            >
              <path
                vectorEffect="non-scaling-stroke"
                strokeLinecap="butt"
                strokeMiterlimit="8"
                d={geometry.ok ? elementInfo.path : ''}
                fill={fill}
                stroke={outlineColor}
                strokeWidth={outlineWidth}
                strokeDasharray={strokeDashArray}
              />
            </g>
          </svg>

          <div
            className={`shape-text flex flex-col px-2.5 py-2.5 leading-relaxed break-words absolute inset-0 ${
              text.align === 'top'
                ? 'justify-start'
                : text.align === 'bottom'
                  ? 'justify-end'
                  : 'justify-center'
            }`}
            style={{
              lineHeight: text.lineHeight,
              letterSpacing: `${text.wordSpace || 0}px`,
            }}
          >
            <div
              ref={proseRef}
              data-inline-math-root=""
              className="ProseMirror-static [&_p]:mb-[var(--paragraphSpace)]"
              style={{
                // @ts-expect-error CSS custom properties
                '--paragraphSpace': `${text.paragraphSpace === undefined ? 5 : text.paragraphSpace}px`,
              }}
              dangerouslySetInnerHTML={innerHtml}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
