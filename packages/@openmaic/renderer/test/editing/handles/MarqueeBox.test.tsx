// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MarqueeBox } from '../../../src/editing/handles/MarqueeBox';

describe('MarqueeBox', () => {
  it('positions and sizes the dashed rect from the canvas-unit rect × scale + offset', () => {
    const { container } = render(
      <MarqueeBox
        rect={{ minX: 100, minY: 50, maxX: 300, maxY: 250 }}
        viewportStyles={{ left: 160, top: 40, width: 1000, height: 562 }}
        canvasScale={0.5}
      />,
    );
    const box = container.querySelector('[data-marquee-box]') as HTMLElement;
    expect(box).not.toBeNull();
    // left = 160 + 100*0.5 = 210; top = 40 + 50*0.5 = 65.
    expect(box.style.left).toBe('210px');
    expect(box.style.top).toBe('65px');
    // width = (300-100)*0.5 = 100; height = (250-50)*0.5 = 100.
    expect(box.style.width).toBe('100px');
    expect(box.style.height).toBe('100px');
  });

  it('is purely visual (never hit-tests)', () => {
    const { container } = render(
      <MarqueeBox
        rect={{ minX: 0, minY: 0, maxX: 10, maxY: 10 }}
        viewportStyles={{ left: 0, top: 0, width: 1000, height: 562 }}
        canvasScale={1}
      />,
    );
    const box = container.querySelector('[data-marquee-box]') as HTMLElement;
    expect(box.style.pointerEvents).toBe('none');
  });
});
