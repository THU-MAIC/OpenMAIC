import type { Token } from './types';
import { childlessTags } from './tags';

interface State {
  str: string;
  position: number;
  tokens: Token[];
}

const jumpPosition = (state: State, end: number) => {
  const len = end - state.position;
  movePositopn(state, len);
};

const movePositopn = (state: State, len: number) => {
  state.position = state.position + len;
};

const findTextEnd = (str: string, index: number) => {
  const isEnd = false;
  while (!isEnd) {
    const textEnd = str.indexOf('<', index);
    if (textEnd === -1) {
      return textEnd;
    }
    const char = str.charAt(textEnd + 1);
    if (char === '/' || char === '!' || /[A-Za-z0-9]/.test(char)) {
      return textEnd;
    }
    index = textEnd + 1;
  }
  return -1;
};

const lexText = (state: State) => {
  const { str } = state;
  let textEnd = findTextEnd(str, state.position);
  if (textEnd === state.position) return;
  if (textEnd === -1) {
    textEnd = str.length;
  }

  const content = str.slice(state.position, textEnd);
  jumpPosition(state, textEnd);

  state.tokens.push({
    type: 'text',
    content,
  });
};

const lexComment = (state: State) => {
  const { str } = state;

  movePositopn(state, 4);
  let contentEnd = str.indexOf('-->', state.position);
  let commentEnd = contentEnd + 3;
  if (contentEnd === -1) {
    contentEnd = commentEnd = str.length;
  }

  const content = str.slice(state.position, contentEnd);
  jumpPosition(state, commentEnd);

  state.tokens.push({
    type: 'comment',
    content,
  });
};

const lexTagName = (state: State) => {
  const { str } = state;
  const len = str.length;
  let start = state.position;

  while (start < len) {
    const char = str.charAt(start);
    const isTagChar = !(/\s/.test(char) || char === '/' || char === '>');
    if (isTagChar) break;
    start++;
  }

  let end = start + 1;
  while (end < len) {
    const char = str.charAt(end);
    const isTagChar = !(/\s/.test(char) || char === '/' || char === '>');
    if (!isTagChar) break;
    end++;
  }

  jumpPosition(state, end);
  const tagName = str.slice(start, end);
  state.tokens.push({
    type: 'tag',
    content: tagName,
  });
  return tagName;
};

const lexTagAttributes = (state: State) => {
  const { str, tokens } = state;
  let cursor = state.position;
  let quote = null;
  let wordBegin = cursor;
  const words = [];
  const len = str.length;
  while (cursor < len) {
    const char = str.charAt(cursor);
    if (quote) {
      const isQuoteEnd = char === quote;
      if (isQuoteEnd) quote = null;
      cursor++;
      continue;
    }

    const isTagEnd = char === '/' || char === '>';
    if (isTagEnd) {
      if (cursor !== wordBegin) words.push(str.slice(wordBegin, cursor));
      break;
    }

    const isWordEnd = /\s/.test(char);
    if (isWordEnd) {
      if (cursor !== wordBegin) words.push(str.slice(wordBegin, cursor));
      wordBegin = cursor + 1;
      cursor++;
      continue;
    }

    const isQuoteStart = char === "'" || char === '"';
    if (isQuoteStart) {
      quote = char;
      cursor++;
      continue;
    }

    cursor++;
  }
  jumpPosition(state, cursor);

  const type = 'attribute';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    const isNotPair = word.indexOf('=') === -1;
    if (isNotPair) {
      const secondWord = words[i + 1];
      if (secondWord && secondWord.startsWith('=')) {
        if (secondWord.length > 1) {
          const newWord = word + secondWord;
          tokens.push({ type, content: newWord });
          i += 1;
          continue;
        }
        const thirdWord = words[i + 2];
        i += 1;
        if (thirdWord) {
          const newWord = word + '=' + thirdWord;
          tokens.push({ type, content: newWord });
          i += 1;
          continue;
        }
      }
    }
    if (word.endsWith('=')) {
      const secondWord = words[i + 1];
      if (secondWord && secondWord.indexOf('=') === -1) {
        const newWord = word + secondWord;
        tokens.push({ type, content: newWord });
        i += 1;
        continue;
      }

      const newWord = word.slice(0, -1);
      tokens.push({ type, content: newWord });
      continue;
    }

    tokens.push({ type, content: word });
  }
};

const lexSkipTag = (tagName: string, state: State) => {
  const { str, tokens } = state;
  const safeTagName = tagName.toLowerCase();
  const len = str.length;
  let index = state.position;

  while (index < len) {
    const nextTag = str.indexOf('</', index);
    if (nextTag === -1) {
      lexText(state);
      break;
    }

    const tagState = {
      str,
      position: state.position,
      tokens: [],
    };
    jumpPosition(tagState, nextTag);
    const name = lexTag(tagState);
    if (safeTagName !== name.toLowerCase()) {
      index = tagState.position;
      continue;
    }

    if (nextTag !== state.position) {
      const textStart = state.position;
      jumpPosition(state, nextTag);
      tokens.push({
        type: 'text',
        content: str.slice(textStart, nextTag),
      });
    }

    tokens.push(...tagState.tokens);
    jumpPosition(state, tagState.position);
    break;
  }
};

const lexTag = (state: State) => {
  const { str } = state;
  const secondChar = str.charAt(state.position + 1);
  const tagStartClose = secondChar === '/';
  movePositopn(state, tagStartClose ? 2 : 1);
  state.tokens.push({
    type: 'tag-start',
    close: tagStartClose,
  });

  const tagName = lexTagName(state);
  lexTagAttributes(state);

  const firstChar = str.charAt(state.position);
  const tagEndClose = firstChar === '/';
  movePositopn(state, tagEndClose ? 2 : 1);
  state.tokens.push({
    type: 'tag-end',
    close: tagEndClose,
  });
  return tagName;
};

const lex = (state: State) => {
  const str = state.str;
  const len = str.length;

  while (state.position < len) {
    const start = state.position;
    lexText(state);

    if (state.position === start) {
      const isComment = str.startsWith('!--', start + 1);
      if (isComment) lexComment(state);
      else {
        const tagName = lexTag(state);
        const safeTag = tagName.toLowerCase();
        if (childlessTags.includes(safeTag)) lexSkipTag(tagName, state);
      }
    }
  }
};

export const lexer = (str: string): Token[] => {
  const state = {
    str,
    position: 0,
    tokens: [],
  };
  lex(state);
  return state.tokens;
};
