// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseXml } from '../src/parser/XmlParser';
import { parseTableNode } from '../src/model/nodes/TableNode';
import { tableToElement } from '../src/serializer/tableSerializer';
import { transformParsedToSlides } from '../src/import-pipeline/transformParsedToSlides';
import { createMockImportContext } from '../src/import-pipeline/mockContext';
import { minimalCtx, parseTxBody } from './helpers';

const fixture = readFileSync(resolve(__dirname, 'fixtures/slide6-table.xml'), 'utf8');
async function importHeader(xml = fixture, node = parseTableNode(parseXml(xml)), column = 3) {
  const parsed = tableToElement(node, minimalCtx(), 0);
  const raw = parsed.data[0][column].text;
  const { slides } = await transformParsedToSlides(
    {
      size: { width: 960, height: 540 },
      themeColors: [],
      slides: [
        {
          fill: { type: 'color', value: '#fff' },
          note: '',
          layoutElements: [],
          elements: [parsed],
        },
      ],
    } as Parameters<typeof transformParsedToSlides>[0],
    createMockImportContext({ viewportWidth: 1280 }),
  );
  const table = slides[0].elements[0];
  if (table.type !== 'table') throw new Error('Expected table');
  const cell = table.data[0][column];
  const host = document.createElement('div');
  host.innerHTML = cell.text;
  return { raw, cell, host };
}
describe('imported table hanging punctuation', () => {
  it('marks the source slide 6 heading and preserves its margins while compacting only the final punctuation', async () => {
    const { raw, cell, host } = await importHeader();
    expect(raw).toContain('data-pptx-hanging-punctuation="true"');
    const punctuation = host.querySelector<HTMLElement>('[data-pptx-hanging-punctuation="true"]');
    expect(punctuation?.textContent).toBe('？');
    expect(punctuation?.style.width).toBe('0.5em');
    expect(punctuation?.style.display).toBe('inline-block');
    expect(cell.padding).toBe('0pt 5.4pt');
    expect(host.textContent).toBe('你的活动高峰时间？');
    expect(host.querySelector('p')?.style.whiteSpace).not.toBe('nowrap');
  });
  it.each(['omitted', 'empty'])('keeps punctuation with %s cell properties', async (properties) => {
    const xml = fixture.replace(
      /<a:tcPr\b[^>]*>[\s\S]*?<\/a:tcPr>/g,
      properties === 'empty' ? '<a:tcPr/>' : '',
    );
    const node = parseTableNode(parseXml(xml));
    // Default 7.2pt side margins; the short heading only fits after half-em compression.
    node.columns[3] = (('你的活动高峰时间？'.length - 0.25) * 20 * 4) / 3 + 19.2;
    expect(node.rows[0].cells[3].properties?.exists() ?? false).toBe(properties === 'empty');
    const { raw, cell, host } = await importHeader(xml, node);
    expect(raw).toContain('data-pptx-hanging-punctuation="true"');
    const punctuation = host.querySelector<HTMLElement>('[data-pptx-hanging-punctuation="true"]');
    expect(punctuation?.textContent).toBe('？');
    expect(punctuation?.style.width).toBe('0.5em');
    expect(punctuation?.style.display).toBe('inline-block');
    expect(cell.padding).toBe('3.6pt 7.2pt');
    expect(host.textContent).toBe('你的活动高峰时间？');
  });
  it.each([
    ['disabled', fixture.replaceAll('hangingPunct="1"', 'hangingPunct="0"')],
    [
      'long prose',
      fixture.replace('你的活动高峰时间？', '你在一整天当中的活动高峰时间是什么时候？'),
    ],
    ['already fits', fixture.replace('你的活动高峰时间？', '高峰时间？')],
  ])('does not compact %s', async (_, xml) => {
    const { raw, host } = await importHeader(xml);
    expect(raw).not.toContain('data-pptx-hanging-punctuation');
    expect(host.querySelector('[data-pptx-hanging-punctuation]')).toBeNull();
  });
});

describe('ordinary table tab stops', () => {
  it.each([true, false])(
    'preserves a tab beyond half the cell width (explicit margins: %s)',
    async (withMargins) => {
      const node = parseTableNode(parseXml(fixture));
      node.columns[0] = 160;
      const cell = node.rows[0].cells[0];
      if (!withMargins) cell.properties = undefined;
      cell.textBody = parseTxBody(
        '<a:bodyPr/><a:p><a:pPr><a:tabLst><a:tab pos="1143000" algn="l"/>' +
          '</a:tabLst></a:pPr><a:r><a:rPr sz="1200"/><a:t>\tHello</a:t></a:r></a:p>',
      );
      const { raw, host } = await importHeader(fixture, node, 0);
      // 1,143,000 EMU = 120 px = 90 pt, then 120 canvas px at ratio 4/3.
      expect(host.querySelector('p')?.style.marginLeft).toBe('120px');
      expect(raw).toContain('margin-left: 120px');
      expect(host.textContent).toBe('Hello');
      expect(host.querySelector('[data-pptx-hanging-punctuation]')).toBeNull();
    },
  );
});
