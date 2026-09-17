// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';
import { renderTxBodyHtml } from './helpers';

async function importCell(xml: string) {
  const text = renderTxBodyHtml(xml);
  const json = {
    size: { width: 960, height: 540 },
    themeColors: [],
    slides: [
      {
        fill: { type: 'color', value: '#ffffff' },
        note: '',
        layoutElements: [],
        elements: [
          {
            type: 'table',
            left: 0,
            top: 0,
            width: 400,
            height: 80,
            borders: {},
            colWidths: [400],
            rowHeights: [80],
            data: [[{ text, borders: {}, colSpan: 1, rowSpan: 1 }]],
          },
        ],
      },
    ],
  };
  const { slides } = await transformParsedToSlides(
    json as unknown as Parameters<typeof transformParsedToSlides>[0],
    createMockImportContext({ viewportWidth: 1280 }),
  );
  const table = slides[0].elements[0];
  if (table.type !== 'table') throw new Error('Expected table');
  const cell = table.data[0][0];
  const element = document.createElement('div');
  element.innerHTML = cell.text;
  return { cell, element };
}

const run = (text: string) =>
  `<a:r><a:rPr sz="2400"><a:latin typeface="Courier New"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r>`;

describe('table tab columns survive the complete import pipeline', () => {
  it('keeps column geometry and extracts the actual text font', async () => {
    const { cell, element } = await importCell(`<a:p>${run('A\tB')}</a:p>`);
    const column = element.querySelector<HTMLElement>('[data-pptx-tab-column="true"]');
    expect(column?.style.width).toBe('96px');
    expect(column?.style.display).toBe('inline-block');
    expect(column?.style.whiteSpace).toBe('pre');
    expect(column?.style.minWidth).toBe('max-content');
    expect(column?.textContent).toBe('A');
    expect(cell.style?.fontsize).toBe('32.0px');
    expect(cell.style?.fontname).toContain('Courier New');
    expect(element.querySelector('span[style*="color"]')?.textContent).toBe('A');
  });

  it('retains empty columns and separate paragraph boundaries', async () => {
    const { element } = await importCell(`<a:p>${run('A\t\tB')}</a:p><a:p>${run('C\tD')}</a:p>`);
    const paragraphs = element.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    const columns = paragraphs[0].querySelectorAll<HTMLElement>('[data-pptx-tab-column="true"]');
    expect(columns).toHaveLength(2);
    expect(columns[1].textContent).toBe('');
    expect(columns[1].style.width).toBe('96px');
    expect(paragraphs[1].querySelector('[data-pptx-tab-column="true"]')?.textContent).toBe('C');
  });
});
