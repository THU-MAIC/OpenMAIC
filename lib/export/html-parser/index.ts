// Reference: https://github.com/andrejewski/himalaya — rewritten in TypeScript with simplified functionality

import { lexer } from './lexer';
import { parser } from './parser';
import { format } from './format';
import { toHTML } from './stringify';
export type { AST } from './types';

export const toAST = (str: string) => {
  const tokens = lexer(str);
  const nodes = parser(tokens);
  return format(nodes);
};

export { toHTML };
