import { describe, expect, it } from 'vitest';

import { formatAttributes, toHTML } from '@/lib/export/html-parser/stringify';
import type { ElementAttribute } from '@/lib/export/html-parser/types';

describe('formatAttributes', () => {
  it('omits an empty style attribute without dropping the others', () => {
    const attrs: ElementAttribute[] = [
      { key: 'class', value: 'foo' },
      { key: 'style', value: '' },
      { key: 'id', value: 'bar' },
    ];
    // Before the fix, the empty style reset the reduce accumulator and `class`
    // (and anything before style) was lost.
    expect(formatAttributes(attrs)).toBe(" class='foo' id='bar'");
  });

  it('keeps a non-empty style attribute', () => {
    expect(formatAttributes([{ key: 'style', value: 'color:red' }])).toBe(" style='color:red'");
  });

  it('renders boolean (null-value) attributes as bare names', () => {
    expect(formatAttributes([{ key: 'disabled', value: null }])).toBe(' disabled');
  });

  it('toHTML keeps sibling attributes when style is empty', () => {
    const html = toHTML([
      {
        type: 'element',
        tagName: 'span',
        attributes: [
          { key: 'class', value: 'hl' },
          { key: 'style', value: '' },
        ],
        children: [{ type: 'text', content: 'x' }],
      },
    ]);
    expect(html).toBe("<span class='hl'>x</span>");
  });
});
