import { describe, expect, it } from 'vitest';
import { formatAttributes, toHTML } from '@/lib/export/html-parser/stringify';
import type { AST, ElementAttribute } from '@/lib/export/html-parser/types';

describe('formatAttributes', () => {
  it('formats a value attribute with single quotes', () => {
    const attrs: ElementAttribute[] = [{ key: 'id', value: 'main' }];
    expect(formatAttributes(attrs)).toBe(" id='main'");
  });

  it('renders a null value as a boolean attribute', () => {
    const attrs: ElementAttribute[] = [{ key: 'disabled', value: null }];
    expect(formatAttributes(attrs)).toBe(' disabled');
  });

  it('switches to double quotes when the value contains a single quote', () => {
    const attrs: ElementAttribute[] = [{ key: 'data-x', value: "it's" }];
    expect(formatAttributes(attrs)).toBe(' data-x="it\'s"');
  });

  it('omits an empty style attribute', () => {
    const attrs: ElementAttribute[] = [{ key: 'style', value: '' }];
    expect(formatAttributes(attrs)).toBe('');
  });

  it('keeps attributes accumulated before an empty style attribute (regression #682)', () => {
    const attrs: ElementAttribute[] = [
      { key: 'id', value: 'a' },
      { key: 'style', value: '' },
      { key: 'class', value: 'b' },
    ];
    // Previously the empty-style branch returned '' and wiped `id`.
    expect(formatAttributes(attrs)).toBe(" id='a' class='b'");
  });

  it('preserves a non-empty style attribute', () => {
    const attrs: ElementAttribute[] = [
      { key: 'id', value: 'a' },
      { key: 'style', value: 'color:red' },
    ];
    expect(formatAttributes(attrs)).toBe(" id='a' style='color:red'");
  });
});

describe('toHTML', () => {
  it('serializes an element whose first attribute precedes an empty style (regression #682)', () => {
    const tree: AST[] = [
      {
        type: 'element',
        tagName: 'div',
        attributes: [
          { key: 'id', value: 'box' },
          { key: 'style', value: '' },
        ],
        children: [{ type: 'text', content: 'hi' }],
      },
    ];
    expect(toHTML(tree)).toBe("<div id='box'>hi</div>");
  });

  it('serializes void tags without a closing tag', () => {
    const tree: AST[] = [
      {
        type: 'element',
        tagName: 'br',
        attributes: [],
        children: [],
      },
    ];
    expect(toHTML(tree)).toBe('<br>');
  });

  it('passes through text and comment nodes', () => {
    const tree: AST[] = [
      { type: 'text', content: 'a' },
      { type: 'comment', content: ' note ' },
    ];
    expect(toHTML(tree)).toBe('a<!-- note -->');
  });
});
