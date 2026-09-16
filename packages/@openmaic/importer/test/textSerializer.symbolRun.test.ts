import { expect, it } from 'vitest';
import { renderTxBodyHtml } from './helpers';

it('preserves ordinary text when a supplemental symbol font remains on the run', () => {
  const html = renderTxBodyHtml(`<a:p><a:r><a:rPr sz="3200">
    <a:latin typeface="仿宋"/><a:ea typeface="仿宋"/><a:sym typeface="Wingdings"/>
    </a:rPr><a:t>：（2022年）</a:t></a:r></a:p>`);
  expect(html).toContain('：（2022年）');
  expect(html).not.toContain('•');
});

it('still converts symbol-private-use characters within a normal text run', () => {
  const html = renderTxBodyHtml(`<a:p><a:r><a:rPr sz="3200">
    <a:latin typeface="Arial"/><a:sym typeface="Wingdings"/>
    </a:rPr><a:t>2022年\uF0D8</a:t></a:r></a:p>`);
  expect(html).toContain('2022年➢');
});

it('retains legacy byte mappings when the text font itself is symbolic', () => {
  const html = renderTxBodyHtml(`<a:p><a:r><a:rPr sz="2400">
    <a:latin typeface="Wingdings"/><a:sym typeface="Wingdings"/>
    </a:rPr><a:t>Ø</a:t></a:r></a:p>`);
  expect(html).toContain('➢');
});
