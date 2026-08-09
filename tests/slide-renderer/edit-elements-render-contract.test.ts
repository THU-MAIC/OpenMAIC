import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  PPTImageElement,
  PPTLatexElement,
  PPTTableElement,
  PPTTextElement,
} from '@openmaic/dsl';
import { useClipImage as useAppClipImage } from '@/components/slide-renderer/components/element/ImageElement/useClipImage';
import { imageFiltersToCss as appImageFiltersToCss } from '@/components/slide-renderer/components/element/ImageElement/useFilter';
import { BaseLatexElement } from '@/components/slide-renderer/components/element/LatexElement/BaseLatexElement';
import { LatexElement } from '@/components/slide-renderer/components/element/LatexElement';
import { BaseTextElement } from '@/components/slide-renderer/components/element/TextElement/BaseTextElement';
import { StaticTable } from '@/components/slide-renderer/components/element/TableElement/StaticTable';
import { useClipImage as usePackageClipImage } from '../../packages/@openmaic/renderer/src/elements/image/useClipImage';
import { imageFiltersToCss as packageImageFiltersToCss } from '../../packages/@openmaic/renderer/src/elements/image/useFilter';
import { BaseTextElement as PackageBaseTextElement } from '../../packages/@openmaic/renderer/src/elements/text/BaseTextElement';
import { StaticTable as PackageStaticTable } from '../../packages/@openmaic/renderer/src/elements/table/StaticTable';

const roundRectImage = {
  id: 'img-1',
  type: 'image',
  left: 0,
  top: 0,
  width: 100,
  height: 100,
  rotate: 0,
  src: 'data:image/png;base64,AA==',
  fixedRatio: false,
  radius: 0,
  clip: {
    shape: 'roundRect',
    range: [
      [0, 0],
      [100, 100],
    ],
  },
} as PPTImageElement;

function clipMarkup(
  useClipImage: (element: PPTImageElement) => { clipShape: { style: string } },
): string {
  function Probe() {
    const { clipShape } = useClipImage(roundRectImage);
    return React.createElement('div', { 'data-clip-style': clipShape.style });
  }
  return renderToStaticMarkup(React.createElement(Probe));
}

const htmlLatex = {
  id: 'latex-1',
  type: 'latex',
  left: 0,
  top: 0,
  width: 200,
  height: 80,
  rotate: 0,
  latex: 'x^2',
  html: '<span class="katex">x²</span>',
  color: '#ff0000',
} as PPTLatexElement;

describe('edit_elements renderer contracts', () => {
  it('renders canonical and legacy filter units identically in both renderers', () => {
    for (const filters of [
      { blur: '2', contrast: '90', brightness: '120', 'hue-rotate': '15' },
      { blur: '2px', contrast: '90%', brightness: '120%', 'hue-rotate': '15deg' },
    ]) {
      expect(packageImageFiltersToCss(filters)).toBe(appImageFiltersToCss(filters));
      expect(packageImageFiltersToCss(filters)).toBe(
        'blur(2px) contrast(90%) brightness(120%) hue-rotate(15deg)',
      );
    }
  });

  it('renders an explicit zero radius for roundRect images in both renderers', () => {
    expect(clipMarkup(useAppClipImage)).toContain('inset(0 round 0px)');
    expect(clipMarkup(usePackageClipImage)).toContain('inset(0 round 0px)');
  });

  it('applies latex color to HTML-backed formulas in editable and read-only app renderers', () => {
    expect(
      renderToStaticMarkup(React.createElement(LatexElement, { elementInfo: htmlLatex })),
    ).toContain('color:#ff0000');
    expect(
      renderToStaticMarkup(React.createElement(BaseLatexElement, { elementInfo: htmlLatex })),
    ).toContain('color:#ff0000');
  });

  it('applies text fill and opacity to the rotating full box in both renderers', () => {
    const text = {
      id: 'text-1',
      type: 'text',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      content: '<p>short</p>',
      defaultFontName: 'Arial',
      defaultColor: '#000000',
      fill: '#ff0000',
      opacity: 0.5,
    } as PPTTextElement;
    for (const Component of [BaseTextElement, PackageBaseTextElement]) {
      const markup = renderToStaticMarkup(React.createElement(Component, { elementInfo: text }));
      expect(markup).toMatch(
        /class="rotate-wrapper[^"]*" style="[^"]*transform:rotate\(0deg\)[^"]*background-color:#ff0000[^"]*opacity:0\.5/,
      );
    }
  });

  it('renders explicit table row heights in the app renderer', () => {
    const table = {
      id: 'table-1',
      type: 'table',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      data: [[{ id: 'a', text: 'A' }], [{ id: 'b', text: 'B' }]],
      colWidths: [1],
      rowHeights: [20, 80],
      cellMinHeight: 36,
      outline: { width: 1, color: '#000000' },
    } as PPTTableElement;
    const markup = renderToStaticMarkup(React.createElement(StaticTable, { elementInfo: table }));
    expect(markup).toContain('height:20px');
    expect(markup).toContain('height:80px');
  });

  it('fills the element height in the package table fallback path', () => {
    const table = {
      id: 'table-fallback',
      type: 'table',
      left: 0,
      top: 0,
      width: 200,
      height: 200,
      rotate: 0,
      data: [[{ id: 'a', text: 'A' }], [{ id: 'b', text: 'B' }]],
      colWidths: [1],
      cellMinHeight: 36,
      outline: { width: 1, color: '#000000' },
    } as PPTTableElement;
    const markup = renderToStaticMarkup(
      React.createElement(PackageStaticTable, { elementInfo: table }),
    );
    expect(markup).toContain('height:100%');
  });
});
