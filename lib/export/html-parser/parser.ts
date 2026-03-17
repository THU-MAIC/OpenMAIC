import type {
  Token,
  HTMLNode,
  TagToken,
  NormalElement,
  TagEndToken,
  AttributeToken,
  TextToken,
} from './types';
import { closingTags, closingTagAncestorBreakers, voidTags } from './tags';

interface StackItem {
  tagName: string | null;
  children: HTMLNode[];
}

interface State {
  stack: StackItem[];
  cursor: number;
  tokens: Token[];
}

export const parser = (tokens: Token[]) => {
  const root: StackItem = { tagName: null, children: [] };
  const state: State = { tokens, cursor: 0, stack: [root] };
  parse(state);
  return root.children;
};

export const hasTerminalParent = (tagName: string, stack: StackItem[]) => {
  const tagParents = closingTagAncestorBreakers[tagName];
  if (tagParents) {
    let currentIndex = stack.length - 1;
    while (currentIndex >= 0) {
      const parentTagName = stack[currentIndex].tagName;
      if (parentTagName === tagName) break;
      if (parentTagName && tagParents.includes(parentTagName)) return true;
      currentIndex--;
    }
  }
  return false;
};

export const rewindStack = (stack: StackItem[], newLength: number) => {
  stack.splice(newLength);
};

export const parse = (state: State) => {
  const { stack, tokens } = state;
  let { cursor } = state;
  let nodes = stack[stack.length - 1].children;
  const len = tokens.length;

  while (cursor < len) {
    const token = tokens[cursor];
    if (token.type !== 'tag-start') {
      nodes.push(token as TextToken);
      cursor++;
      continue;
    }

    const tagToken = tokens[++cursor] as TagToken;
    cursor++;
    const tagName = tagToken.content.toLowerCase();
    if (token.close) {
      let index = stack.length;
      let shouldRewind = false;
      while (--index > -1) {
        if (stack[index].tagName === tagName) {
          shouldRewind = true;
          break;
        }
      }
      while (cursor < len) {
        if (tokens[cursor].type !== 'tag-end') break;
        cursor++;
      }
      if (shouldRewind) {
        rewindStack(stack, index);
        break;
      } else continue;
    }

    const isClosingTag = closingTags.includes(tagName);
    let shouldRewindToAutoClose = isClosingTag;
    if (shouldRewindToAutoClose) {
      shouldRewindToAutoClose = !hasTerminalParent(tagName, stack);
    }

    if (shouldRewindToAutoClose) {
      let currentIndex = stack.length - 1;
      while (currentIndex > 0) {
        if (tagName === stack[currentIndex].tagName) {
          rewindStack(stack, currentIndex);
          const previousIndex = currentIndex - 1;
          nodes = stack[previousIndex].children;
          break;
        }
        currentIndex = currentIndex - 1;
      }
    }

    const attributes = [];
    let tagEndToken: TagEndToken | undefined;
    while (cursor < len) {
      const _token = tokens[cursor];
      if (_token.type === 'tag-end') {
        tagEndToken = _token;
        break;
      }
      attributes.push((_token as AttributeToken).content);
      cursor++;
    }

    if (!tagEndToken) break;

    cursor++;
    const children: HTMLNode[] = [];
    const elementNode: NormalElement = {
      type: 'element',
      tagName: tagToken.content,
      attributes,
      children,
    };
    nodes.push(elementNode);

    const hasChildren = !(tagEndToken.close || voidTags.includes(tagName));
    if (hasChildren) {
      stack.push({ tagName, children });
      const innerState = { tokens, cursor, stack };
      parse(innerState);
      cursor = innerState.cursor;
    }
  }
  state.cursor = cursor;
};
