import { describe, expect, it } from 'vitest';
import { renderTxBodyHtml } from './helpers';

const paragraph = (text: string, spacing = '') => `
  <a:p><a:pPr algn="ctr">${spacing}</a:pPr>
    <a:r><a:rPr sz="2400"><a:latin typeface="Arial"/></a:rPr><a:t>${text}</a:t></a:r>
  </a:p>`;
const percent = (value: number) => `<a:lnSpc><a:spcPct val="${value}"/></a:lnSpc>`;

describe('auto-fit text frame single spacing', () => {
  it('retains natural font leading for implicit single spacing (slide 7 overlays)', () => {
    const html = renderTxBodyHtml(
      `<a:bodyPr><a:spAutoFit/></a:bodyPr>${paragraph('int')}`,
      undefined,
      { frameHeightPx: 461665 / 9525 },
    );
    expect(html).toContain('line-height: 38.8688px');
    expect(html).not.toContain('padding-top:');
  });

  it('retains natural leading between explicitly single-spaced paragraphs (slide 6 labels)', () => {
    const html = renderTxBodyHtml(
      `<a:bodyPr><a:spAutoFit/></a:bodyPr>
      ${paragraph('数字', percent(100000))}${paragraph('文字', percent(100000))}`,
      undefined,
      { frameHeightPx: 830997 / 9525 },
    );
    expect(html.match(/line-height: 38.8219px/g)).toHaveLength(2);
  });

  it.each([
    ['<a:noAutofit/>', '', '1'],
    ['<a:normAutofit/>', '', '1'],
    ['<a:spAutoFit/>', percent(150000), '1.5'],
    ['<a:spAutoFit/>', '<a:lnSpc><a:spcPts val="2800"/></a:lnSpc>', '28pt'],
  ])(
    'preserves fixed-frame and explicit non-single spacing: %s %s',
    (autoFit, spacing, expected) => {
      const html = renderTxBodyHtml(
        `<a:bodyPr>${autoFit}</a:bodyPr>${paragraph('文字', spacing)}`,
        undefined,
        { frameHeightPx: 461665 / 9525 },
      );
      expect(html).toContain(`line-height: ${expected}`);
      expect(html).not.toContain('line-height: 38.8688px');
    },
  );
  it.each([
    [undefined, paragraph('未知尺寸')],
    [201.6, paragraph('长正文').repeat(5)],
    [100, paragraph('有折行的长文本')],
    [48, paragraph('数字') + paragraph('文字')],
    [48, paragraph('文字').replace('sz="2400"', 'sz="1800"') + paragraph('数字')],
    [48, paragraph('第一行\n第二行')],
    [48, paragraph('文字', '<a:spcAft><a:spcPts val="600"/></a:spcAft>')],
  ])('does not infer leading for ambiguous frames: %s', (height, content) => {
    const html = renderTxBodyHtml(`<a:bodyPr><a:spAutoFit/></a:bodyPr>${content}`, undefined, {
      frameHeightPx: height,
    });
    expect(html).not.toMatch(/line-height: [\d.]+px/);
  });
});
