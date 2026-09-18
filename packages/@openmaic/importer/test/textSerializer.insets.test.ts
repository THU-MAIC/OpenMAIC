import { expect, it } from 'vitest';
import { renderTxBodyHtml } from './helpers';

it.each(['', ' lIns="0" rIns="0" tIns="0" bIns="0"'])(
  'marks imported text insets including explicit zero values (%s)',
  (attrs) => {
    const html = renderTxBodyHtml(`<a:bodyPr${attrs}/><a:p><a:r><a:t>Text</a:t></a:r></a:p>`);
    expect(html).toMatch(/^<div data-pptx-text-insets="true" style="padding:/);
    if (attrs) expect(html).toContain('padding: 0pt 0pt 0pt 0pt;');
    else expect(html).toContain('padding: 3.6pt 7.2pt 3.6pt 7.2pt;');
  },
);
