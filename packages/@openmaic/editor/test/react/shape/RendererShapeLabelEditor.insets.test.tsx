// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';
import { RendererShapeLabelEditor } from '../../../src/react/shape/RendererShapeLabelEditor';

const shape: PPTShapeElement = {
  id: 'shape-1',
  type: 'shape',
  left: 0,
  top: 0,
  width: 200,
  height: 100,
  rotate: 0,
  viewBox: [200, 100],
  path: 'M0 0 L200 100',
  fill: '#fff',
  fixedRatio: false,
  text: {
    content: '<p>Label</p>',
    align: 'middle',
    defaultFontName: 'Arial',
    defaultColor: '#000',
  },
};

describe('RendererShapeLabelEditor insets', () => {
  it.each([
    '<div data-pptx-text-insets="true" style="padding: 0pt"><p>Imported</p></div>',
    '<div style="padding: 4pt 8pt"><p>Legacy imported</p></div>',
  ])('does not add padding to an imported label: %s', (content) => {
    const { container } = render(
      <RendererShapeLabelEditor element={{ ...shape, text: { ...shape.text!, content } }} />,
    );
    expect((container.querySelector('.shape-text') as HTMLElement).style.padding).toBe('0px');
  });

  it('keeps the default inset for an authored label', () => {
    const { container } = render(<RendererShapeLabelEditor element={shape} />);
    expect((container.querySelector('.shape-text') as HTMLElement).style.padding).toBe('10px');
  });
});
