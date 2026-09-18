import { inlineMath } from './inlineMath';
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

// Tab columns own their text so adjacent equal-width columns cannot coalesce
// as marks, and formatting part of the text cannot duplicate the column box.
const pptxTabColumn: NodeSpec = {
  inline: true,
  group: 'inline',
  content: 'inline*',
  selectable: false,
  whitespace: 'pre',
  attrs: {
    width: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span[data-pptx-tab-column="true"]',
      priority: 100,
      preserveWhitespace: 'full',
      getAttrs: (dom) => {
        const { width } = (dom as HTMLElement).style;
        return CSS_LENGTH_PATTERN.test(width) ? { width } : false;
      },
    },
  ],
  toDOM: (node: Node) => [
    'span',
    {
      'data-pptx-tab-column': 'true',
      style: `display: inline-block; width: ${node.attrs.width}; min-width: max-content; text-align: left; text-indent: 0; white-space: pre;`,
    },
    0,
  ],
};

// A fixed-width box owns its contents, even when font marks differ inside it.
// Keeping it as a node prevents font-mark ordering from splitting the box.
const inlineTextBox: NodeSpec = {
  inline: true,
  group: 'inline',
  content: 'inline*',
  selectable: false,
  attrs: {
    width: {},
    minWidth: { default: '' },
    textAlign: { default: '' },
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
      priority: 60,
      getAttrs: (dom) => {
        const element = dom as HTMLElement;
        const {
          display,
          width,
          minWidth,
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
          (!element.textContent?.trim() && element.dataset.inlineTextBox !== 'true') ||
          display !== 'inline-block' ||
          !CSS_LENGTH_PATTERN.test(width)
        )
          return false;
        return {
          width,
          minWidth: minWidth === 'max-content' ? minWidth : '',
          textAlign: element.style.textAlign === 'left' ? 'left' : '',
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
    if (mark.attrs.minWidth === 'max-content') style += 'min-width: max-content;';
    if (mark.attrs.textAlign === 'left') style += 'text-align: left;';
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
    return ['span', { 'data-inline-text-box': 'true', style }, 0];
  },
};

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
    pptxTextInsets: { default: false },
  },
  parseDOM: [
    {
      tag: 'div',
      getAttrs: (dom) => {
        const padding = (dom as HTMLElement).style.padding;
        const pptxTextInsets =
          (dom as HTMLElement).getAttribute('data-pptx-text-insets') === 'true';
        return padding || pptxTextInsets ? { padding, pptxTextInsets } : false;
      },
    },
  ],
  toDOM: (node: Node) => [
    'div',
    {
      ...(node.attrs.padding ? { style: `padding: ${node.attrs.padding};` } : {}),
      ...(node.attrs.pptxTextInsets ? { 'data-pptx-text-insets': 'true' } : {}),
    },
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
    // Explicit left alignment must override a centered table cell ancestor.
    if (align) style += `text-align: ${align};`;
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
  inline_math: inlineMath,
  text_container: textContainer,
  ordered_list: orderedList,
  bullet_list: bulletList,
  list_item: listItem,
  inline_spacer: inlineSpacer,
  pptx_tab_column: pptxTabColumn,
  inline_text_box: inlineTextBox,
};

export default schemaNodes;
