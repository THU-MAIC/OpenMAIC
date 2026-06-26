'use client';

import { useMemo, type ReactNode } from 'react';
import {
  ElementTypes,
  type PPTElement,
  type PPTImageElement,
  type PPTVideoElement,
  type SlideTheme,
} from '@openmaic/dsl';

import { BaseImageElement } from './elements/image/BaseImageElement';
import { BaseTextElement } from './elements/text/BaseTextElement';
import { BaseShapeElement } from './elements/shape/BaseShapeElement';
import { BaseLineElement } from './elements/line/BaseLineElement';
import { BaseChartElement } from './elements/chart/BaseChartElement';
import { BaseLatexElement } from './elements/latex/BaseLatexElement';
import { BaseTableElement } from './elements/table/BaseTableElement';
import { BaseVideoElement } from './elements/video/BaseVideoElement';
import { BaseCodeElement } from './elements/code/BaseCodeElement';

const DEFAULT_THEME = {
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
} as const;

export interface SlideElementProps {
  elementInfo: PPTElement;
  elementIndex: number;
  theme?: Pick<SlideTheme, 'fontColor' | 'fontName'>;
  animate?: boolean;
  renderImage?: (element: PPTImageElement, resolvedSrc: string) => ReactNode;
  renderVideo?: (element: PPTVideoElement) => ReactNode;
  onElementClick?: (element: PPTElement, event: React.MouseEvent) => void;
  /** Prefix used for the root div id — must match SpotlightOverlay's `elementIdPrefix`. */
  idPrefix?: string;
}

export function SlideElement({
  elementInfo,
  elementIndex,
  theme,
  animate,
  renderImage,
  renderVideo,
  onElementClick,
  idPrefix = 'slide-element-',
}: SlideElementProps) {
  const Component = useMemo(() => {
    switch (elementInfo.type) {
      case ElementTypes.IMAGE:
        return 'image';
      case ElementTypes.TEXT:
        return 'text';
      case ElementTypes.SHAPE:
        return 'shape';
      case ElementTypes.LINE:
        return 'line';
      case ElementTypes.CHART:
        return 'chart';
      case ElementTypes.LATEX:
        return 'latex';
      case ElementTypes.TABLE:
        return 'table';
      case ElementTypes.VIDEO:
        return 'video';
      case ElementTypes.CODE:
        return 'code';
      default:
        return null;
    }
  }, [elementInfo.type]);

  if (!Component) return null;

  const fontColor = theme?.fontColor ?? DEFAULT_THEME.fontColor;
  const fontName = theme?.fontName ?? DEFAULT_THEME.fontName;
  const renderedElement = (
    <>
      {Component === 'text' && elementInfo.type === 'text' && (
        <BaseTextElement elementInfo={elementInfo} />
      )}
      {Component === 'shape' && elementInfo.type === 'shape' && (
        <BaseShapeElement elementInfo={elementInfo} />
      )}
      {Component === 'image' && elementInfo.type === 'image' && (
        <BaseImageElement elementInfo={elementInfo} renderImage={renderImage} />
      )}
      {Component === 'line' && elementInfo.type === 'line' && (
        <BaseLineElement elementInfo={elementInfo} animate={animate} />
      )}
      {Component === 'chart' && elementInfo.type === 'chart' && (
        <BaseChartElement elementInfo={elementInfo} />
      )}
      {Component === 'latex' && elementInfo.type === 'latex' && (
        <BaseLatexElement elementInfo={elementInfo} />
      )}
      {Component === 'table' && elementInfo.type === 'table' && (
        <BaseTableElement elementInfo={elementInfo} />
      )}
      {Component === 'video' && elementInfo.type === 'video' && (
        <BaseVideoElement elementInfo={elementInfo} renderVideo={renderVideo} />
      )}
      {Component === 'code' && elementInfo.type === 'code' && (
        <BaseCodeElement elementInfo={elementInfo} animate={animate} />
      )}
    </>
  );

  return (
    <div
      className="slide-element"
      id={`${idPrefix}${elementInfo.id}`}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: elementIndex,
        color: fontColor,
        fontFamily: fontName,
        pointerEvents: 'none',
      }}
      onClick={onElementClick ? (e) => onElementClick(elementInfo, e) : undefined}
    >
      <div
        className="slide-element-hit-target"
        style={onElementClick ? { pointerEvents: 'auto' } : undefined}
      >
        {renderedElement}
      </div>
    </div>
  );
}
