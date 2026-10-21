'use client';

import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { PPTTextElement } from '@openmaic/dsl';
import { useElementShadow } from '../shared/useElementShadow';
import { ElementOutline } from '../shared/ElementOutline';
import { preservesPlainTextLineBreaks } from '../../utils/richText';
import { useInlineMath, useInnerHtml } from '../../utils/inlineMath';
import { hasTextInsets } from '../shared/hasTextInsets';

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
  renderContent?: (element: PPTTextElement, defaultContent: ReactNode) => ReactNode;
  /** Keep a recovered shape's label container sized for an absolute-positioned editor. */
  fillHeight?: boolean;
}

export function BaseTextElement({
  elementInfo,
  target,
  renderContent,
  fillHeight = false,
}: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const proseRef = useRef<HTMLDivElement>(null);
  const innerHtml = useInnerHtml(elementInfo.content);
  useInlineMath(proseRef, elementInfo.content);
  // Imported OOXML text carries its own bodyPr insets on the outer div.
  // Adding the editor's default inset again shifts the label and reduces line width.
  const contentHasTextInsets = hasTextInsets(elementInfo.content);

  const vAlign = elementInfo.vAlign ?? 'top';
  const justifyContent =
    vAlign === 'middle' ? 'center' : vAlign === 'bottom' ? 'flex-end' : 'flex-start';
  const defaultContent = (
    <div
      ref={proseRef}
      data-inline-math-root=""
      className="text ProseMirror-static"
      style={{
        position: 'relative',
        pointerEvents: target === 'thumbnail' ? 'none' : undefined,
        whiteSpace: preservesPlainTextLineBreaks(elementInfo.content) ? 'pre-line' : undefined,
      }}
      dangerouslySetInnerHTML={innerHtml}
    />
  );

  return (
    <div
      className="base-element-text"
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
          // Fill the full text box and rotate it with the glyphs/outline.
          backgroundColor: elementInfo.fill,
          opacity: elementInfo.opacity,
          display: 'flex',
          flexDirection: 'column',
          justifyContent,
        }}
      >
        <div
          className="element-content slide-renderer-prose"
          style={{
            position: 'relative',
            boxSizing: 'border-box',
            padding: contentHasTextInsets ? 0 : '10px',
            overflowWrap: 'break-word',
            width: elementInfo.vertical ? 'auto' : '100%',
            height: elementInfo.vertical || fillHeight ? '100%' : 'auto',
            display: fillHeight ? 'flex' : undefined,
            flexDirection: fillHeight ? 'column' : undefined,
            justifyContent: fillHeight ? justifyContent : undefined,
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight,
            letterSpacing:
              elementInfo.wordSpace !== undefined ? `${elementInfo.wordSpace}px` : undefined,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            ...(elementInfo.paragraphSpace !== undefined
              ? ({ '--paragraphSpace': `${elementInfo.paragraphSpace}px` } as CSSProperties)
              : null),
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          {renderContent?.(elementInfo, defaultContent) ?? defaultContent}
        </div>
      </div>
    </div>
  );
}
