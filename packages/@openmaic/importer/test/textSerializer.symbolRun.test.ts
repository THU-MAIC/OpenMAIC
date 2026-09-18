import { expect, it } from 'vitest';
import { renderTxBodyHtml } from './helpers';

it.each([
  ['Wingdings', 'ü'],
  ['Arial', '\uF0FC'],
])('preserves checkmarks in %s symbol runs', (latin, text) => {
  const html = renderTxBodyHtml(`<a:p><a:r><a:rPr sz="1800">
    <a:latin typeface="${latin}"/><a:sym typeface="Wingdings"/>
    </a:rPr><a:t>${text}</a:t></a:r></a:p>`);
  expect(html).toContain('✓');
  expect(html).not.toContain('●');
});

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

it.each([
  ['legacy byte', 'Wingdings 3', '{'],
  ['private use', 'Arial', '\uF07B'],
])('preserves the upper-right triangle for Wingdings 3 %s characters', (_, latin, text) => {
  const html = renderTxBodyHtml(`<a:p><a:r><a:rPr sz="2400">
    <a:latin typeface="${latin}"/><a:sym typeface="Wingdings 3"/>
    </a:rPr><a:t>${text}</a:t></a:r></a:p>`);
  expect(html).toContain('◥');
  expect(html).not.toContain('▲');
});

it.each([
  ['Wingdings 3', '{'],
  ['Wingdings', 'n'],
])('preserves ordinary ASCII with supplemental %s font information', (symbol, text) => {
  const html = renderTxBodyHtml(`<a:p><a:r><a:rPr sz="2400">
    <a:latin typeface="Arial"/><a:sym typeface="${symbol}"/>
    </a:rPr><a:t>${text}</a:t></a:r></a:p>`);
  expect(html).toContain(`>${text}</span>`);
});
