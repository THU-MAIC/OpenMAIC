'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PPTElement, Slide } from '@openmaic/dsl';
import { SLIDE_RENDERER_STYLES, SlideElement, SlideRendererProvider } from '@openmaic/renderer';
import { useResolvedSlideMedia } from '@/components/slide-renderer/use-resolved-slide';
import { SCREEN_ELEMENT_ID_PREFIX } from '@/components/slide-renderer/element-dom';

const EVAL_SLIDE_ID = '__eval_slide__';
const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 563;
const EVAL_THEME = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
};

function WhiteboardCanvas() {
  const [elements, setElements] = useState<PPTElement[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Expose setter for Playwright
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__setElements = (incoming: PPTElement[]) => setElements(incoming);

    // Signal readiness
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__evalReady = true;
    // Defer setReady to avoid cascading render warning
    queueMicrotask(() => setReady(true));
  }, []);

  const slide = useMemo<Slide>(
    () => ({
      id: EVAL_SLIDE_ID,
      viewportSize: CANVAS_WIDTH,
      viewportRatio: CANVAS_HEIGHT / CANVAS_WIDTH,
      theme: EVAL_THEME,
      elements,
    }),
    [elements],
  );
  const resolved = useResolvedSlideMedia(slide);

  if (!ready) return null;

  return (
    <SlideRendererProvider slide={resolved.slide} classroomSizing>
      <div
        className="eval-whiteboard-canvas"
        style={{
          position: 'relative',
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          backgroundColor: '#ffffff',
          overflow: 'hidden',
        }}
      >
        <style dangerouslySetInnerHTML={{ __html: SLIDE_RENDERER_STYLES }} />
        {resolved.slide.elements.map((element, index) => (
          <SlideElement
            key={element.id}
            elementInfo={element}
            elementIndex={index}
            theme={EVAL_THEME}
            idPrefix={SCREEN_ELEMENT_ID_PREFIX}
          />
        ))}
      </div>
    </SlideRendererProvider>
  );
}

export default function EvalWhiteboardPage() {
  return <WhiteboardCanvas />;
}
