'use client';

import { useMemo, useRef, type ReactNode } from 'react';
import type { PPTShapeElement, ShapeText } from '@openmaic/dsl';
import {
  validateShapeGeometry,
  RENDER_PATH_LIMITS,
  shapeToTextFallback,
  type PathValidation,
} from '@openmaic/geometry';
import { useElementOutline } from '../shared/useElementOutline';
import { useElementShadow } from '../shared/useElementShadow';
import { useElementFlip } from '../shared/useElementFlip';
import { useElementFill } from '../shared/useElementFill';
import { GradientDefs } from './GradientDefs';
import { BaseTextElement } from '../text/BaseTextElement';
import { PatternDefs } from './PatternDefs';
import { preservesPlainTextLineBreaks } from '../../utils/richText';
import { useInlineMath, useInnerHtml } from '../../utils/inlineMath';
import { hasTextInsets } from '../shared/hasTextInsets';

export interface BaseShapeElementProps {
  elementInfo: PPTShapeElement;
  /** Replace the static Shape label with editor content. */
  renderLabel?: (element: PPTShapeElement, defaultContent: ReactNode) => ReactNode;
}

export function BaseShapeElement({ elementInfo, renderLabel }: BaseShapeElementProps) {
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
  if (!geometry.ok) {
    const fallback = shapeToTextFallback(elementInfo);
    return fallback ? (
      <div data-shape-geometry-error={geometry.error.code}>
        <BaseTextElement
          elementInfo={fallback}
          fillHeight={Boolean(renderLabel)}
          renderContent={
            renderLabel ? (_text, content) => renderLabel(elementInfo, content) : undefined
          }
        />
      </div>
    ) : null;
  }
  return (
    <ValidShapeElement elementInfo={elementInfo} renderLabel={renderLabel} geometry={geometry} />
  );
}

function ValidShapeElement({
  elementInfo,
  renderLabel,
  geometry,
}: BaseShapeElementProps & {
  geometry: Extract<PathValidation, { ok: true }>;
}) {
  const width = elementInfo.width;
  const height = elementInfo.height;
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

  const justifyContent =
    text.align === 'top' ? 'flex-start' : text.align === 'bottom' ? 'flex-end' : 'center';
  const defaultLabelContent = (
    <div
      className="shape-text"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent,
        overflowWrap: 'break-word',
        boxSizing: 'border-box',
        padding: hasTextInsets(text.content) ? 0 : 10,
        lineHeight: text.lineHeight ?? 1.625,
        letterSpacing: `${text.wordSpace || 0}px`,
        // PowerPoint/WPS 在 group flipH/flipV 时只镜像几何与位置，文字字形保持
        // 正向。父层 element-content 已应用 flipStyle 镜像 SVG path；这里给文字
        // 叠加同一个 flipStyle，两次 flip 抵消，让文字保持正向。
        transform: flipStyle,
      }}
    >
      <div
        ref={proseRef}
        data-inline-math-root=""
        className="ProseMirror-static slide-renderer-prose"
        style={{
          // @ts-expect-error CSS custom properties
          '--paragraphSpace': `${text.paragraphSpace === undefined ? 5 : text.paragraphSpace}px`,
          whiteSpace: preservesPlainTextLineBreaks(text.content) ? 'pre-line' : undefined,
        }}
        dangerouslySetInnerHTML={innerHtml}
      />
    </div>
  );

  return (
    <div
      className="base-element-shape"
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${width}px`,
        height: `${height}px`,
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
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            opacity: elementInfo.opacity,
            filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
            transform: flipStyle,
            color: text.defaultColor,
            fontFamily: text.defaultFontName,
          }}
        >
          {(() => {
            // The shape's path can extend OUTSIDE its width×height box (e.g.
            // curved connectors whose extreme adj values bulge the curve far
            // past the bbox). A browser shows that via overflow:visible, but
            // html2canvas-pro rasterizes each SVG to its width×height viewport
            // and CLIPS the overflow — turning connector arcs into stubs in the
            // exported PNG. Fix: grow the SVG viewport to contain the full path
            // bbox and offset it back, so the geometry renders in the exact same
            // place but nothing falls outside the captured viewport.
            const sx = elementInfo.width / elementInfo.viewBox[0];
            const sy = elementInfo.height / elementInfo.viewBox[1];
            const bbox = geometry.bounds;
            const CAP = 4000; // guard against pathological coords blowing up the SVG
            let padL = 0;
            let padT = 0;
            let padR = 0;
            let padB = 0;
            if (bbox) {
              padL = Math.min(CAP, Math.max(0, -bbox.minX * sx));
              padT = Math.min(CAP, Math.max(0, -bbox.minY * sy));
              padR = Math.min(CAP, Math.max(0, bbox.maxX * sx - elementInfo.width));
              padB = Math.min(CAP, Math.max(0, bbox.maxY * sy - elementInfo.height));
            }
            return (
              <svg
                overflow="visible"
                width={width + padL + padR}
                height={height + padT + padB}
                style={{
                  position: 'absolute',
                  left: -padL,
                  top: -padT,
                  transformOrigin: '0 0',
                  overflow: 'visible',
                  display: 'block',
                }}
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
                <g transform={`translate(${padL},${padT}) scale(${sx}, ${sy})`}>
                  <path
                    vectorEffect="non-scaling-stroke"
                    strokeLinecap="butt"
                    strokeMiterlimit="8"
                    d={elementInfo.path}
                    fill={fill}
                    stroke={outlineColor}
                    strokeWidth={outlineWidth}
                    strokeDasharray={strokeDashArray}
                  />
                </g>
              </svg>
            );
          })()}

          {renderLabel ? renderLabel(elementInfo, defaultLabelContent) : defaultLabelContent}
        </div>
      </div>
    </div>
  );
}
