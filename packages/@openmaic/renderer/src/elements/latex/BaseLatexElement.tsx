'use client';

import { useCallback, useEffect, useRef, useState, useLayoutEffect } from 'react';
import type { PPTLatexElement } from '@openmaic/dsl';

export interface BaseLatexElementProps {
  elementInfo: PPTLatexElement;
}

export function BaseLatexElement({ elementInfo }: BaseLatexElementProps) {
  return (
    <div
      className="base-element-latex"
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
            // KaTeX glyphs inherit `color`; apply the formula's resolved color
            // (e.g. 蓝色权重) so it isn't forced to the browser default.
            ...(elementInfo.color ? { color: elementInfo.color } : {}),
          }}
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
              style={{ transformOrigin: '0 0', overflow: 'visible' }}
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

const ALIGN_MAP = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
} as const;

function KatexContent({
  html,
  width,
  height,
  align = 'center',
}: {
  html: string;
  width: number;
  height: number;
  align?: 'left' | 'center' | 'right';
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // Measure the formula's natural size and shrink-to-fit its box. Extracted so
  // it can run both synchronously on mount (useLayoutEffect) and again once the
  // KaTeX fonts finish loading (useEffect below).
  //
  // KaTeX lays out large delimiters (\left\{, \begin{cases}) using the metrics of
  // its `KaTeX_Size1`–`Size4` faces. Those woff2 files load asynchronously, so a
  // first measure on a cold export runs against the fallback font — the brace is
  // sized wrong and the piecewise body (`cases`) desynchronizes from it (the bug
  // reported as "大括号后面的分段函数与大括号错位"). Re-measuring after
  // `document.fonts.ready` snaps the scale back to the real glyph metrics before
  // the off-screen snapshot captures the frame.
  const measure = useCallback(() => {
    if (!innerRef.current) return;
    const naturalW = innerRef.current.scrollWidth;
    const naturalH = innerRef.current.scrollHeight;
    if (naturalW > 0 && naturalH > 0) {
      // Cap at 1: only ever shrink the formula to fit its box, never enlarge.
      // A short formula sitting in a large frame (e.g. slide 29 的右侧推理框)
      // would otherwise get scaled up to fill the box and render huge.
      setScale(Math.min(width / naturalW, height / naturalH, 1));
    }
  }, [width, height]);

  useLayoutEffect(() => {
    measure();
  }, [measure, html]);

  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return;
    let cancelled = false;
    // Re-measure once the font set settles (initial + any subsequent face that
    // finishes decoding), so the fit-scale reflects the real KaTeX_Size metrics.
    fonts.ready.then(() => {
      if (!cancelled) measure();
    });
    const onLoadingDone = () => measure();
    fonts.addEventListener?.('loadingdone', onLoadingDone);
    return () => {
      cancelled = true;
      fonts.removeEventListener?.('loadingdone', onLoadingDone);
    };
  }, [measure, html]);

  const justify = ALIGN_MAP[align];
  const origin =
    align === 'left' ? 'left center' : align === 'right' ? 'right center' : 'center center';

  return (
    <div
      style={{
        width,
        height,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: justify,
      }}
    >
      <div
        ref={innerRef}
        className="slide-renderer-prose"
        style={{
          transformOrigin: origin,
          transform: `scale(${scale})`,
          whiteSpace: 'nowrap',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
