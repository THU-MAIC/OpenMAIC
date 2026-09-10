import { marks } from 'prosemirror-schema-basic';
import type { MarkSpec } from 'prosemirror-model';

const CSS_LENGTH_PATTERN =
  /^-?(?:\d+|\d*\.\d+)(?:px|pt|pc|mm|cm|in|rem|em|ex|ch|vw|vh|vmin|vmax|%)$/i;

const subscript: MarkSpec = {
  excludes: 'subscript',
  parseDOM: [
    { tag: 'sub' },
    {
      style: 'vertical-align',
      getAttrs: (value) => value === 'sub' && null,
    },
  ],
  toDOM: () => ['sub', 0],
};

const superscript: MarkSpec = {
  excludes: 'superscript',
  parseDOM: [
    { tag: 'sup' },
    {
      style: 'vertical-align',
      getAttrs: (value) => value === 'super' && null,
    },
  ],
  toDOM: () => ['sup', 0],
};

const strikethrough: MarkSpec = {
  parseDOM: [
    { tag: 'strike' },
    {
      style: 'text-decoration',
      getAttrs: (value) => value === 'line-through' && null,
    },
    {
      style: 'text-decoration-line',
      getAttrs: (value) => value === 'line-through' && null,
    },
  ],
  toDOM: () => ['span', { style: 'text-decoration-line: line-through;' }, 0],
};

const underline: MarkSpec = {
  parseDOM: [
    { tag: 'u' },
    {
      style: 'text-decoration',
      getAttrs: (value) => value === 'underline' && null,
    },
    {
      style: 'text-decoration-line',
      getAttrs: (value) => value === 'underline' && null,
    },
  ],
  toDOM: () => ['span', { style: 'text-decoration: underline;' }, 0],
};

const forecolor: MarkSpec = {
  attrs: {
    color: {},
  },
  inline: true,
  group: 'inline',
  parseDOM: [
    {
      style: 'color',
      getAttrs: (color) => (color ? { color } : {}),
    },
  ],
  toDOM: (mark) => {
    const { color } = mark.attrs;
    let style = '';
    if (color) style += `color: ${color};`;
    return ['span', { style }, 0];
  },
};

const backcolor: MarkSpec = {
  attrs: {
    backcolor: {},
  },
  inline: true,
  group: 'inline',
  parseDOM: [
    {
      style: 'background-color',
      getAttrs: (backcolor) => (backcolor ? { backcolor } : {}),
    },
  ],
  toDOM: (mark) => {
    const { backcolor } = mark.attrs;
    let style = '';
    if (backcolor) style += `background-color: ${backcolor};`;
    return ['span', { style }, 0];
  },
};

const fontsize: MarkSpec = {
  attrs: {
    fontsize: {},
  },
  inline: true,
  group: 'inline',
  parseDOM: [
    {
      style: 'font-size',
      getAttrs: (fontsize) => (fontsize ? { fontsize } : {}),
    },
  ],
  toDOM: (mark) => {
    const { fontsize } = mark.attrs;
    let style = '';
    if (fontsize) style += `font-size: ${fontsize};`;
    return ['span', { style }, 0];
  },
};

const letterSpacing: MarkSpec = {
  attrs: {
    letterSpacing: {},
  },
  inline: true,
  group: 'inline',
  parseDOM: [
    {
      style: 'letter-spacing',
      getAttrs: (letterSpacing) => (letterSpacing ? { letterSpacing } : {}),
    },
  ],
  toDOM: (mark) => ['span', { style: `letter-spacing: ${mark.attrs.letterSpacing};` }, 0],
};

const inlineBlock: MarkSpec = {
  attrs: {
    width: {},
    height: { default: '' },
    verticalAlign: { default: '' },
    margin: { default: '' },
    marginTop: { default: '' },
    marginRight: { default: '' },
    marginBottom: { default: '' },
    marginLeft: { default: '' },
    padding: { default: '' },
    paddingTop: { default: '' },
    paddingRight: { default: '' },
    paddingBottom: { default: '' },
    paddingLeft: { default: '' },
    textIndent: { default: '' },
    boxSizing: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span',
      getAttrs: (dom) => {
        const element = dom as HTMLElement;
        const {
          display,
          width,
          height,
          verticalAlign,
          margin,
          marginTop,
          marginRight,
          marginBottom,
          marginLeft,
          padding,
          paddingTop,
          paddingRight,
          paddingBottom,
          paddingLeft,
          textIndent,
          boxSizing,
        } = element.style;
        if (
          !element.textContent?.trim() ||
          display !== 'inline-block' ||
          !CSS_LENGTH_PATTERN.test(width)
        )
          return false;
        return {
          width,
          height,
          verticalAlign,
          margin,
          marginTop,
          marginRight,
          marginBottom,
          marginLeft,
          padding,
          paddingTop,
          paddingRight,
          paddingBottom,
          paddingLeft,
          textIndent: textIndent === '0px' || textIndent === '0' ? '0' : '',
          boxSizing: boxSizing === 'border-box' ? boxSizing : '',
        };
      },
    },
  ],
  toDOM: (mark) => {
    let style = `display: inline-block; width: ${mark.attrs.width};`;
    if (mark.attrs.height) style += `height: ${mark.attrs.height};`;
    if (mark.attrs.verticalAlign) style += `vertical-align: ${mark.attrs.verticalAlign};`;
    if (mark.attrs.margin) style += `margin: ${mark.attrs.margin};`;
    if (mark.attrs.marginTop) style += `margin-top: ${mark.attrs.marginTop};`;
    if (mark.attrs.marginRight) style += `margin-right: ${mark.attrs.marginRight};`;
    if (mark.attrs.marginBottom) style += `margin-bottom: ${mark.attrs.marginBottom};`;
    if (mark.attrs.marginLeft) style += `margin-left: ${mark.attrs.marginLeft};`;
    if (mark.attrs.padding) style += `padding: ${mark.attrs.padding};`;
    if (mark.attrs.paddingTop) style += `padding-top: ${mark.attrs.paddingTop};`;
    if (mark.attrs.paddingRight) style += `padding-right: ${mark.attrs.paddingRight};`;
    if (mark.attrs.paddingBottom) style += `padding-bottom: ${mark.attrs.paddingBottom};`;
    if (mark.attrs.paddingLeft) style += `padding-left: ${mark.attrs.paddingLeft};`;
    if (mark.attrs.textIndent) style += 'text-indent: 0;';
    if (mark.attrs.boxSizing) style += `box-sizing: ${mark.attrs.boxSizing};`;
    return ['span', { style }, 0];
  },
};

const fontname: MarkSpec = {
  attrs: {
    fontname: {},
  },
  inline: true,
  group: 'inline',
  parseDOM: [
    {
      style: 'font-family',
      getAttrs: (fontname) => {
        return {
          fontname: fontname && typeof fontname === 'string' ? fontname.replace(/[\"\']/g, '') : '',
        };
      },
    },
  ],
  toDOM: (mark) => {
    const { fontname } = mark.attrs;
    let style = '';
    // Quote the family name — unquoted, a name with spaces or a trailing digit
    // (e.g. "Source Sans 3") is an invalid font-family value and gets dropped.
    // parseDOM's getAttrs strips the quotes again, so the attr round-trips clean.
    // Reject `"` or `\` (illegal in a CSS family name): rendering them unescaped
    // here would let a hand-crafted mark close the quoted string and inject
    // arbitrary CSS at `toDOM`.
    if (fontname && !/["\\]/.test(fontname)) {
      style += `font-family: "${fontname}";`;
    }
    return ['span', { style }, 0];
  },
};

const link: MarkSpec = {
  attrs: {
    href: {},
    title: { default: null },
    target: { default: '_blank' },
  },
  inclusive: false,
  parseDOM: [
    {
      tag: 'a[href]',
      getAttrs: (dom) => {
        const href = (dom as HTMLElement).getAttribute('href');
        const title = (dom as HTMLElement).getAttribute('title');
        return { href, title };
      },
    },
  ],
  toDOM: (node) => ['a', node.attrs, 0],
};

const mark: MarkSpec = {
  attrs: {
    index: { default: null },
  },
  parseDOM: [
    {
      tag: 'mark',
      getAttrs: (dom) => {
        const index = (dom as HTMLElement).dataset.index;
        return { index };
      },
    },
  ],
  toDOM: (node) => ['mark', { 'data-index': node.attrs.index }, 0],
};

const { em, strong, code } = marks;

const schemaMarks = {
  em,
  strong,
  fontsize,
  letterSpacing,
  inlineBlock,
  fontname,
  code,
  forecolor,
  backcolor,
  subscript,
  superscript,
  strikethrough,
  underline,
  link,
  mark,
};

export default schemaMarks;
