// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { PPTElement } from '@openmaic/dsl';

const baseTextElementRender = vi.hoisted(() => vi.fn(() => null));

vi.mock('../src/elements/text/BaseTextElement', () => ({
  BaseTextElement: baseTextElementRender,
}));

import { SlideElement } from '../src/SlideElement';

const element = {
  id: 'text-1',
  type: 'text',
  left: 10,
  top: 20,
  width: 200,
  height: 80,
  rotate: 0,
  content: '<p>hello</p>',
  defaultFontName: 'Arial',
  defaultColor: '#000000',
  lineHeight: 1,
} as PPTElement;

describe('SlideElement memoization', () => {
  beforeEach(() => baseTextElementRender.mockClear());

  it('does not rerender an unchanged element when its parent rerenders', () => {
    const { rerender } = render(<SlideElement elementInfo={element} elementIndex={1} />);

    rerender(<SlideElement elementInfo={element} elementIndex={1} />);

    expect(baseTextElementRender).toHaveBeenCalledTimes(1);
  });

  it('rerenders when the element object changes', () => {
    const { rerender } = render(<SlideElement elementInfo={element} elementIndex={1} />);

    rerender(<SlideElement elementInfo={{ ...element, left: 30 }} elementIndex={1} />);

    expect(baseTextElementRender).toHaveBeenCalledTimes(2);
  });

  it('moves the wrapper on the compositor without rerendering element content', () => {
    const { container, rerender } = render(
      <SlideElement elementInfo={element} elementIndex={1} dragOffset={{ x: 0, y: 0 }} />,
    );

    rerender(<SlideElement elementInfo={element} elementIndex={1} dragOffset={{ x: 30, y: 20 }} />);

    expect(baseTextElementRender).toHaveBeenCalledTimes(1);
    expect(
      (container.querySelector('.slide-element-hit-target') as HTMLElement).style.transform,
    ).toBe('translate3d(30px, 20px, 0)');
  });
});
