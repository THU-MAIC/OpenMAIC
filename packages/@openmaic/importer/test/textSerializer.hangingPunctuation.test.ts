import { expect, it } from 'vitest';
import { renderTxBodyHtml } from './helpers';
const render = (width: number, hanging = '1', text = '课前调研：') =>
  renderTxBodyHtml(
    `<a:bodyPr wrap="square"/><a:p><a:pPr hangingPunct="${hanging}" algn="just"/><a:r><a:rPr sz="2000"/><a:t>${text}</a:t></a:r></a:p>`,
    undefined,
    { frameWidthPx: width },
  );
it('allows the final CJK punctuation to hang when only its blank half exceeds the frame', () => {
  expect(render(146.8)).toContain('display:inline-block;width:0.5em');
  expect(render(146.8)).not.toContain('white-space: nowrap');
});
it.each([
  [300, '1'],
  [100, '1'],
  [146.8, '0'],
] as const)('keeps normal spacing for width %s / hanging %s', (w, h) =>
  expect(render(w, h)).not.toContain('width:0.5em'),
);
it('does not reinterpret latin text', () =>
  expect(render(146.8, '1', 'A long label:')).not.toContain('width:0.5em'));

it.each([
  '<a:bodyPr><a:normAutofit fontScale="70000"/></a:bodyPr><a:p><a:pPr hangingPunct="1"/><a:r><a:rPr sz="2000"/><a:t>课前调研：</a:t></a:r></a:p>',
  '<a:p><a:pPr hangingPunct="1"/><a:r><a:rPr sz="2000" baseline="30000"/><a:t>课前调研：</a:t></a:r></a:p>',
  '<a:p><a:pPr hangingPunct="1"><a:defRPr sz="2000" baseline="30000"/></a:pPr><a:r><a:t>课前调研：</a:t></a:r></a:p>',
])('does not compress already scaled text: %s', (xml) => {
  expect(renderTxBodyHtml(xml, undefined, { frameWidthPx: 146.8 })).not.toContain('width:0.5em');
});

it('does not compact punctuation inheriting a smaller paragraph font', () => {
  const html = renderTxBodyHtml(
    '<a:bodyPr wrap="square"/><a:p><a:pPr hangingPunct="1" algn="r"><a:defRPr sz="1200"/></a:pPr><a:r><a:rPr sz="2000"/><a:t>课前调研</a:t></a:r><a:r><a:t>：</a:t></a:r></a:p>',
    undefined,
    { frameWidthPx: 146.8 },
  );
  expect(html).toContain('font-size: 12pt');
  expect(html).not.toContain('width:0.5em');
});
it('still compacts uniform inherited font sizes', () => {
  const html = renderTxBodyHtml(
    '<a:bodyPr wrap="square"/><a:p><a:pPr hangingPunct="1"><a:defRPr sz="2000"/></a:pPr><a:r><a:t>课前调研</a:t></a:r><a:r><a:t>：</a:t></a:r></a:p>',
    undefined,
    { frameWidthPx: 146.8 },
  );
  expect(html).toContain('width:0.5em');
});
