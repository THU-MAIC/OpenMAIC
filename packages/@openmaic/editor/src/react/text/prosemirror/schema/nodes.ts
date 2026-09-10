import { nodes } from 'prosemirror-schema-basic';
import type { Node, NodeSpec } from 'prosemirror-model';
import { listItem as _listItem } from 'prosemirror-schema-list';

type Attr = Record<string, number | string>;

const CSS_LENGTH_PATTERN =
  /^-?(?:\d+|\d*\.\d+)(?:px|pt|pc|mm|cm|in|rem|em|ex|ch|vw|vh|vmin|vmax|%)$/i;
const WHITE_SPACE_VALUES = new Set([
  'normal',
  'nowrap',
  'pre',
  'pre-wrap',
  'pre-line',
  'break-spaces',
]);

const inlineSpacer: NodeSpec = {
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,
  attrs: {
    width: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span',
      getAttrs: (dom) => {
        const element = dom as HTMLElement;
        const { display, width } = element.style;
        if (
          element.textContent?.trim() ||
          display !== 'inline-block' ||
          !CSS_LENGTH_PATTERN.test(width)
        ) {
          return false;
        }
        return { width };
      },
    },
  ],
  toDOM: (node: Node) => ['span', { style: `display: inline-block; width: ${node.attrs.width};` }],
};

const textContainer: NodeSpec = {
  group: 'block',
  content: 'block+',
  attrs: {
    padding: { default: '' },
  },
  parseDOM: [
    {
      tag: 'div',
      getAttrs: (dom) => {
        const padding = (dom as HTMLElement).style.padding;
        return padding ? { padding } : false;
      },
    },
  ],
  toDOM: (node: Node) => [
    'div',
    node.attrs.padding ? { style: `padding: ${node.attrs.padding};` } : {},
    0,
  ],
};

const orderedList: NodeSpec = {
  attrs: {
    order: {
      default: 1,
    },
    listStyleType: {
      default: '',
    },
    fontsize: {
      default: '',
    },
    color: {
      default: '',
    },
  },
  content: 'list_item+',
  group: 'block',
  parseDOM: [
    {
      tag: 'ol',
      getAttrs: (dom) => {
        const order =
          ((dom as HTMLElement).hasAttribute('start')
            ? (dom as HTMLElement).getAttribute('start')
            : 1) || 1;
        const attr: Attr = { order: +order };

        const { listStyleType, fontSize, color } = (dom as HTMLElement).style;
        if (listStyleType) attr['listStyleType'] = listStyleType;
        if (fontSize) attr['fontsize'] = fontSize;
        if (color) attr['color'] = color;

        return attr;
      },
    },
  ],
  toDOM: (node: Node) => {
    const { order, listStyleType, fontsize, color } = node.attrs;
    let style = '';
    if (listStyleType) style += `list-style-type: ${listStyleType};`;
    if (fontsize) style += `font-size: ${fontsize};`;
    if (color) style += `color: ${color};`;

    const attr: Attr = { style };
    if (order !== 1) attr['start'] = order;

    return ['ol', attr, 0];
  },
};

const bulletList: NodeSpec = {
  attrs: {
    listStyleType: {
      default: '',
    },
    fontsize: {
      default: '',
    },
    color: {
      default: '',
    },
  },
  content: 'list_item+',
  group: 'block',
  parseDOM: [
    {
      tag: 'ul',
      getAttrs: (dom) => {
        const attr: Attr = {};

        const { listStyleType, fontSize, color } = (dom as HTMLElement).style;
        if (listStyleType) attr['listStyleType'] = listStyleType;
        if (fontSize) attr['fontsize'] = fontSize;
        if (color) attr['color'] = color;

        return attr;
      },
    },
  ],
  toDOM: (node: Node) => {
    const { listStyleType, fontsize, color } = node.attrs;
    let style = '';
    if (listStyleType) style += `list-style-type: ${listStyleType};`;
    if (fontsize) style += `font-size: ${fontsize};`;
    if (color) style += `color: ${color};`;

    return ['ul', { style }, 0];
  },
};

const listItem: NodeSpec = {
  ..._listItem,
  content: 'paragraph block*',
  group: 'block',
};

const paragraph: NodeSpec = {
  attrs: {
    align: {
      default: '',
    },
    indent: {
      default: 0,
    },
    textIndent: {
      default: 0,
    },
    // PPTX import serializes first-line indentation in px. Keep that exact
    // CSS length while editing so it does not drift when the paragraph uses a
    // font size other than the editor's historical 16px conversion base.
    textIndentCss: {
      default: '',
    },
    fontsize: {
      default: '',
    },
    lineHeight: {
      default: '',
    },
    marginLeft: {
      default: '',
    },
    marginTop: {
      default: '',
    },
    marginBottom: {
      default: '',
    },
    paddingTop: {
      default: '',
    },
    whiteSpace: {
      default: '',
    },
  },
  content: 'inline*',
  group: 'block',
  parseDOM: [
    {
      tag: 'p',
      getAttrs: (dom) => {
        const {
          textAlign,
          textIndent,
          fontSize,
          lineHeight,
          marginLeft,
          marginTop,
          marginBottom,
          paddingTop,
          whiteSpace,
        } = (dom as HTMLElement).style;

        let align = (dom as HTMLElement).getAttribute('align') || textAlign || '';
        align = /(left|right|center|justify)/.test(align) ? align : '';

        let textIndentLevel = 0;
        let textIndentCss = '';
        if (textIndent) {
          if (/^-?(?:\d+|\d*\.\d+)em$/i.test(textIndent)) {
            textIndentLevel = parseFloat(textIndent);
          } else if (/px/.test(textIndent)) {
            textIndentLevel = Math.floor(parseFloat(textIndent) / 16);
            if (!textIndentLevel) textIndentLevel = 1;
            textIndentCss = textIndent;
          } else if (CSS_LENGTH_PATTERN.test(textIndent)) {
            textIndentCss = textIndent;
          }
        }

        const indent = +((dom as HTMLElement).getAttribute('data-indent') || 0);

        return {
          align,
          indent,
          textIndent: textIndentLevel,
          textIndentCss,
          fontsize: fontSize,
          lineHeight,
          marginLeft,
          marginTop,
          marginBottom,
          paddingTop,
          whiteSpace: WHITE_SPACE_VALUES.has(whiteSpace) ? whiteSpace : '',
        };
      },
    },
    {
      tag: 'img',
      ignore: true,
    },
    {
      tag: 'pre',
      skip: true,
    },
  ],
  toDOM: (node: Node) => {
    const {
      align,
      indent,
      textIndent,
      textIndentCss,
      fontsize,
      lineHeight,
      marginLeft,
      marginTop,
      marginBottom,
      paddingTop,
      whiteSpace,
    } = node.attrs;
    let style = '';
    if (align && align !== 'left') style += `text-align: ${align};`;
    if (textIndentCss) style += `text-indent: ${textIndentCss};`;
    else if (textIndent) style += `text-indent: ${textIndent}em;`;
    if (fontsize) style += `font-size: ${fontsize};`;
    if (lineHeight) style += `line-height: ${lineHeight};`;
    if (marginLeft) style += `margin-left: ${marginLeft};`;
    if (marginTop) style += `margin-top: ${marginTop};`;
    if (marginBottom) style += `margin-bottom: ${marginBottom};`;
    if (paddingTop) style += `padding-top: ${paddingTop};`;
    if (whiteSpace) style += `white-space: ${whiteSpace};`;

    const attr: Attr = { style };
    if (indent) attr['data-indent'] = indent;

    return ['p', attr, 0];
  },
};

const { doc, blockquote, hard_break, text } = nodes;

const schemaNodes = {
  doc,
  paragraph,
  blockquote,
  hard_break,
  text,
  text_container: textContainer,
  ordered_list: orderedList,
  bullet_list: bulletList,
  list_item: listItem,
  inline_spacer: inlineSpacer,
};

export default schemaNodes;
