// @vitest-environment jsdom
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import type { Slide } from '@openmaic/dsl';

const baseTextElementRender = vi.hoisted(() => vi.fn(() => null));

vi.mock('../../src/elements/text/BaseTextElement', () => ({
  BaseTextElement: baseTextElementRender,
}));
vi.mock('../../src/hooks/useViewportSize', () => ({
  useViewportSize: vi.fn(() => ({
    viewportStyles: { left: 0, top: 0, width: 1000, height: 562.5 },
    fitScale: 1,
  })),
}));

import { EditableSlideCanvas } from '../../src/editing/EditableSlideCanvas';

const ELEMENT_COUNT = 200;
const elements = Array.from({ length: ELEMENT_COUNT }, (_, index) => ({
  id: `text-${index}`,
  type: 'text',
  left: (index % 20) * 40,
  top: Math.floor(index / 20) * 40,
  width: 30,
  height: 30,
  rotate: 0,
  content: `<p>${index}</p>`,
  defaultFontName: 'Arial',
  defaultColor: '#000000',
  lineHeight: 1,
}));
const slide = {
  id: 'performance-slide',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  elements,
} as unknown as Slide;

describe('EditableSlideCanvas drag rendering budget', () => {
  it('rerenders only the dragged slide element during a working-copy update', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    baseTextElementRender.mockClear();

    const measurements: Array<{ phase: string; actualDuration: number }> = [];
    const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
      measurements.push({ phase, actualDuration });
    };
    const { container } = render(
      <Profiler id="editable-slide" onRender={onRender}>
        <EditableSlideCanvas
          slide={slide}
          scale={1}
          selection={{ elementIds: ['text-0'], primaryId: 'text-0' }}
          onSelectionChange={vi.fn()}
          onElementsChange={vi.fn()}
          snapping={false}
        />
      </Profiler>,
    );

    const hit = container.querySelector('[data-element-id="text-0"]') as HTMLElement;
    fireEvent.pointerDown(hit, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 30, clientY: 20 });

    const expectedCalls = process.env.RENDERER_PERF_BASELINE === '1' ? 400 : 200;
    expect(baseTextElementRender).toHaveBeenCalledTimes(expectedCalls);

    if (process.env.RENDERER_PERF_REPORT === '1') {
      const update = measurements.findLast((measurement) => measurement.phase === 'update');
      process.stdout.write(
        `RENDERER_PERF ${JSON.stringify({ elementCount: ELEMENT_COUNT, ...update })}\n`,
      );
    }
  });
});
