import type { NodeType, Schema } from 'prosemirror-model';
import {
  inputRules,
  wrappingInputRule,
  smartQuotes,
  emDash,
  ellipsis,
  InputRule,
} from 'prosemirror-inputrules';

const blockQuoteRule = (nodeType: NodeType) => wrappingInputRule(/^\s*>\s$/, nodeType);

const orderedListRule = (nodeType: NodeType) =>
  wrappingInputRule(
    /^(\d+)\.\s$/,
    nodeType,
    (match) => ({ order: +match[1] }),
    (match, node) => node.childCount + node.attrs.order === +match[1],
  );

const bulletListRule = (nodeType: NodeType) => wrappingInputRule(/^\s*([-+*])\s$/, nodeType);

const codeRule = () => {
  const inputRegex = /(?:^|\s)((?:`)((?:[^`]+))(?:`))$/;

  return new InputRule(inputRegex, (state, match, start, end) => {
    const { schema } = state;

    const tr = state.tr.insertText(`${match[2]} `, start, end);
    const mark = schema.marks.code.create();

    return tr.addMark(start, start + match[2].length, mark);
  });
};

const linkRule = () => {
  const urlRegEx = /(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\.?(?:\d+)?(?:\/\S*)?$/;

  return new InputRule(urlRegEx, (state, match, start, end) => {
    const { schema } = state;

    const tr = state.tr.insertText(match[0], start, end);
    const mark = schema.marks.link.create({ href: match[0], title: match[0] });

    return tr.addMark(start, start + match[0].length, mark);
  });
};

export const buildInputRules = (schema: Schema) => {
  const rules = [...smartQuotes, ellipsis, emDash];
  rules.push(blockQuoteRule(schema.nodes.blockquote));
  rules.push(orderedListRule(schema.nodes.ordered_list));
  rules.push(bulletListRule(schema.nodes.bullet_list));
  rules.push(codeRule());
  rules.push(linkRule());

  return inputRules({ rules });
};
