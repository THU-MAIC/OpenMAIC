'use client';

import { memo, useMemo, type ReactNode } from 'react';
import {
  ElementTypes,
  type PPTElement,
  type PPTImageElement,
  type PPTAudioElement,
  type PPTShapeElement,
  type PPTTableElement,
  type PPTTextElement,
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
import { BaseAudioElement } from './elements/audio/BaseAudioElement';
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
  renderImage?: (
    element: PPTImageElement,
    resolvedSrc: string,
    defaultContent: ReactNode,
  ) => ReactNode;
  renderVideo?: (element: PPTVideoElement) => ReactNode;
  renderText?: (element: PPTTextElement, defaultContent: ReactNode) => ReactNode;
  renderShapeLabel?: (element: PPTShapeElement, defaultContent: ReactNode) => ReactNode;
  renderTable?: (element: PPTTableElement, defaultContent: ReactNode) => ReactNode;
  videoInteractive?: boolean;
  onElementClick?: (element: PPTElement, event: React.MouseEvent) => void;
  /** Prefix used for the root div id — must match SpotlightOverlay's `elementIdPrefix`. */
  idPrefix?: string;
  /** Compositor-only offset used by the editing surface during a move gesture. */
  dragOffset?: { x: number; y: number };
}

type SlideElementContentProps = Pick<
  SlideElementProps,
  | 'elementInfo'
  | 'animate'
  | 'renderImage'
  | 'renderVideo'
  | 'renderText'
  | 'renderShapeLabel'
  | 'renderTable'
  | 'videoInteractive'
>;

const SlideElementContent = memo(function SlideElementContent({
  elementInfo,
  animate,
  renderImage,
  renderVideo,
  renderText,
  renderShapeLabel,
  renderTable,
  videoInteractive,
}: SlideElementContentProps) {
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
      case ElementTypes.AUDIO:
        return 'audio';
      case ElementTypes.CODE:
        return 'code';
      default:
        return null;
    }
  }, [elementInfo.type]);

  if (!Component) return null;

  return (
    <>
      {Component === 'text' && elementInfo.type === 'text' && (
        <BaseTextElement elementInfo={elementInfo} renderContent={renderText} />
      )}
      {Component === 'shape' && elementInfo.type === 'shape' && (
        <BaseShapeElement elementInfo={elementInfo} renderLabel={renderShapeLabel} />
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
        <BaseTableElement elementInfo={elementInfo} renderContent={renderTable} />
      )}
      {Component === 'video' && elementInfo.type === 'video' && (
        <BaseVideoElement
          elementInfo={elementInfo}
          renderVideo={renderVideo}
          interactive={videoInteractive}
        />
      )}
      {Component === 'audio' && elementInfo.type === 'audio' && (
        <BaseAudioElement elementInfo={elementInfo as PPTAudioElement} />
      )}
      {Component === 'code' && elementInfo.type === 'code' && (
        <BaseCodeElement elementInfo={elementInfo} animate={animate} />
      )}
    </>
  );
});

export const SlideElement = memo(function SlideElement({
  elementInfo,
  elementIndex,
  theme,
  animate,
  renderImage,
  renderVideo,
  renderText,
  renderShapeLabel,
  renderTable,
  videoInteractive,
  onElementClick,
  idPrefix = 'slide-element-',
  dragOffset,
}: SlideElementProps) {
  const fontColor = theme?.fontColor ?? DEFAULT_THEME.fontColor;
  const fontName = theme?.fontName ?? DEFAULT_THEME.fontName;

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
        style={{
          pointerEvents: onElementClick ? 'auto' : undefined,
          transform: dragOffset
            ? `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)`
            : undefined,
          willChange: dragOffset ? 'transform' : undefined,
        }}
      >
        <SlideElementContent
          elementInfo={elementInfo}
          animate={animate}
          renderImage={renderImage}
          renderVideo={renderVideo}
          renderText={renderText}
          renderShapeLabel={renderShapeLabel}
          renderTable={renderTable}
          videoInteractive={videoInteractive}
        />
      </div>
    </div>
  );
});
