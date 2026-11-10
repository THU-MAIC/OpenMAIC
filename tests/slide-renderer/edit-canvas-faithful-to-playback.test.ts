import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PPTChartElement, PPTLatexElement, PPTTableElement } from '@openmaic/dsl';
import type { SceneContent } from '@/lib/types/stage';
import { EditableElement } from '@/components/slide-renderer/Editor/Canvas/EditableElement';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import { ChartElement } from '@/components/slide-renderer/components/element/ChartElement';
import { BaseLatexElement } from '@/components/slide-renderer/components/element/LatexElement/BaseLatexElement';
import { LatexElement } from '@/components/slide-renderer/components/element/LatexElement';
import { TableElement } from '@/components/slide-renderer/components/element/TableElement';

const scene = vi.hoisted(() => ({ content: undefined as unknown }));

vi.mock('@/lib/contexts/scene-context', () => ({
  useSceneSelector: (selector: (content: unknown) => unknown) => selector(scene.content),
}));
vi.mock('@/lib/hooks/use-canvas-operations', () => ({ useCanvasOperations: () => ({}) }));

const table = {
  id: 'table-1',
  type: 'table',
  left: 0,
  top: 0,
  width: 200,
  height: 100,
  rotate: 0,
  data: [[{ id: 'a', text: 'no color of its own', colspan: 1, rowspan: 1 }]],
  colWidths: [1],
  cellMinHeight: 36,
  outline: { width: 1, color: '#000000', style: 'solid' },
} as PPTTableElement;

function slideContent(fontColor: string, fontName: string): SceneContent {
  return { type: 'slide', canvas: { theme: { fontColor, fontName } } } as unknown as SceneContent;
}

function renderBoth(): string[] {
  return [
    React.createElement(ScreenElement, { elementInfo: table, elementIndex: 1 }),
    React.createElement(EditableElement, {
      elementInfo: table,
      elementIndex: 1,
      isMultiSelect: false,
      selectElement: () => {},
      openLinkDialog: () => {},
    }),
  ].map((node) => renderToStaticMarkup(node));
}

describe('editing canvas stays faithful to playback', () => {
  it('gives uncolored text the slide theme in Learn and Edit, not the app theme', () => {
    scene.content = slideContent('#123456', 'Slide Font');
    for (const markup of renderBoth()) {
      expect(markup).toMatch(/^<div[^>]*style="[^"]*color:#123456;font-family:Slide Font/);
    }
  });

  it('falls back to the default slide text without a theme', () => {
    scene.content = { type: 'slide', canvas: {} };
    for (const markup of renderBoth()) {
      expect(markup).toMatch(/^<div[^>]*style="[^"]*color:#333333;font-family:Microsoft YaHei/);
    }
  });

  it('does not clip a table border or chart outline drawn past the element box', () => {
    const chart = {
      id: 'chart-1',
      type: 'chart',
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      rotate: 0,
      chartType: 'bar',
      themeColors: ['#000000'],
      data: { labels: ['a'], legends: ['s'], series: [[1]] },
    } as PPTChartElement;
    const tableMarkup = renderToStaticMarkup(
      React.createElement(TableElement, { elementInfo: table }),
    );
    const chartMarkup = renderToStaticMarkup(
      React.createElement(ChartElement, { elementInfo: chart }),
    );
    expect(tableMarkup).toContain('element-content');
    expect(tableMarkup).not.toContain('overflow-hidden');
    expect(chartMarkup).toContain('element-content');
    expect(chartMarkup).not.toMatch(/class="element-content[^"]*overflow-hidden/);
  });

  it.each(['left', 'center', 'right'] as const)('places a %s-aligned formula alike', (align) => {
    const latex = {
      id: 'latex-1',
      type: 'latex',
      left: 0,
      top: 0,
      width: 200,
      height: 80,
      rotate: 0,
      latex: 'x',
      html: '<span class="katex">x</span>',
      align,
    } as PPTLatexElement;
    const formula = (markup: string) => markup.slice(markup.indexOf('<div style="width:200px'));
    expect(
      formula(renderToStaticMarkup(React.createElement(LatexElement, { elementInfo: latex }))),
    ).toBe(
      formula(renderToStaticMarkup(React.createElement(BaseLatexElement, { elementInfo: latex }))),
    );
  });
});
