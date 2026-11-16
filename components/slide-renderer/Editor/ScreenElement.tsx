'use client';

import { ElementTypes, type PPTElement } from '@openmaic/dsl';
import { useMemo } from 'react';

import { BaseImageElement } from '../components/element/ImageElement/BaseImageElement';
import { BaseTextElement } from '../components/element/TextElement/BaseTextElement';
import { BaseShapeElement } from '../components/element/ShapeElement/BaseShapeElement';
import { BaseLineElement } from '../components/element/LineElement/BaseLineElement';
import { BaseChartElement } from '../components/element/ChartElement/BaseChartElement';
import { BaseLatexElement } from '../components/element/LatexElement/BaseLatexElement';
import { BaseTableElement } from '../components/element/TableElement/BaseTableElement';
import { BaseVideoElement } from '../components/element/VideoElement/BaseVideoElement';
import { BaseCodeElement } from '../components/element/CodeElement/BaseCodeElement';
import { maicElementIdAttributes, screenElementDomId } from '../element-dom';
import { useSlideTextStyle } from '../use-slide-text-style';

interface ScreenElementProps {
  readonly elementInfo: PPTElement;
  readonly elementIndex: number;
  readonly animate?: boolean;
  readonly selectable?: boolean;
}

export function ScreenElement({
  elementInfo,
  elementIndex,
  animate,
  selectable,
}: ScreenElementProps) {
  const CurrentElementComponent = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- element components have varying prop signatures
    const elementTypeMap: Record<string, any> = {
      [ElementTypes.IMAGE]: BaseImageElement,
      [ElementTypes.TEXT]: BaseTextElement,
      [ElementTypes.SHAPE]: BaseShapeElement,
      [ElementTypes.LINE]: BaseLineElement,
      [ElementTypes.CHART]: BaseChartElement,
      [ElementTypes.LATEX]: BaseLatexElement,
      [ElementTypes.TABLE]: BaseTableElement,
      [ElementTypes.VIDEO]: BaseVideoElement,
      [ElementTypes.CODE]: BaseCodeElement,
      // TODO: Add other element types
      // [ElementTypes.AUDIO]: BaseAudioElement,
    };
    return elementTypeMap[elementInfo.type] || null;
  }, [elementInfo.type]);

  const textStyle = useSlideTextStyle();

  if (!CurrentElementComponent) {
    return null;
  }

  return (
    <div
      className="screen-element"
      id={screenElementDomId(elementInfo.id)}
      {...maicElementIdAttributes(elementInfo.id)}
      style={{
        zIndex: elementIndex,
        ...textStyle,
      }}
    >
      <CurrentElementComponent
        elementInfo={elementInfo}
        animate={animate}
        selectable={selectable}
      />
    </div>
  );
}
