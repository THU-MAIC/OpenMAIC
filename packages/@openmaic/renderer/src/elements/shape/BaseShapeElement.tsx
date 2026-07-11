'use client';

import type { PPTShapeElement, ShapeText } from '@openmaic/dsl';
import { useElementOutline } from '../shared/useElementOutline';
import { useElementShadow } from '../shared/useElementShadow';
import { useElementFlip } from '../shared/useElementFlip';
import { useElementFill } from '../shared/useElementFill';
import { GradientDefs } from './GradientDefs';
import { PatternDefs } from './PatternDefs';

export interface BaseShapeElementProps {
  elementInfo: PPTShapeElement;
}

/**
 * Bounding box of a path's coordinates (path/viewBox space). Uses control
 * points for curves (a safe superset). Handles the commands our shapes emit
 * (M/L/C/Q/S/H/V/A/T/Z, absolute). Returns null if no coordinates.
 */
function pathCoordBBox(
  d: string,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens) return null;
  let i = 0;
  let cmd = '';
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const addX = (x: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  };
  const addY = (y: number) => {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    // Path commands are single letters. Use an anchored test so number tokens
    // in scientific notation (e.g. "4.74e-16") aren't misread as commands.
    if (/^[a-zA-Z]$/.test(tokens[i])) {
      cmd = tokens[i];
      i++;
    }
    const c = cmd.toUpperCase();
    if (c === 'M' || c === 'L' || c === 'T') {
      addX(num());
      addY(num());
    } else if (c === 'C') {
      addX(num());
      addY(num());
      addX(num());
      addY(num());
      addX(num());
      addY(num());
    } else if (c === 'Q' || c === 'S') {
      addX(num());
      addY(num());
      addX(num());
      addY(num());
    } else if (c === 'H') {
      addX(num());
    } else if (c === 'V') {
      addY(num());
    } else if (c === 'A') {
      num();
      num();
      num();
      num();
      num();
      addX(num());
      addY(num());
    } else if (c === 'Z') {
      // no coords
    } else {
      i++; // unknown token, skip to avoid infinite loop
    }
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return null;
  }
  return { minX, minY, maxX, maxY };
}

export function BaseShapeElement({ elementInfo }: BaseShapeElementProps) {
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

  const justifyContent =
    text.align === 'top' ? 'flex-start' : text.align === 'bottom' ? 'flex-end' : 'center';

  return (
    <div
      className="base-element-shape"
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
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
            const sx = elementInfo.width / (elementInfo.viewBox[0] || elementInfo.width || 1);
            const sy = elementInfo.height / (elementInfo.viewBox[1] || elementInfo.height || 1);
            const bbox = pathCoordBBox(elementInfo.path);
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
                width={elementInfo.width + padL + padR}
                height={elementInfo.height + padT + padB}
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

          <div
            className="shape-text"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              justifyContent,
              overflowWrap: 'break-word',
              lineHeight: text.lineHeight,
              letterSpacing: `${text.wordSpace || 0}px`,
              // PowerPoint/WPS 在 group flipH/flipV 时只镜像几何与位置，文字字形保持
              // 正向。父层 element-content 已应用 flipStyle 镜像 SVG path；这里给文字
              // 叠加同一个 flipStyle，两次 flip 抵消，让文字保持正向。
              transform: flipStyle,
            }}
          >
            <div
              className="ProseMirror-static slide-renderer-prose"
              style={{
                // @ts-expect-error CSS custom properties
                '--paragraphSpace': `${text.paragraphSpace === undefined ? 5 : text.paragraphSpace}px`,
              }}
              dangerouslySetInnerHTML={{ __html: text.content }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
