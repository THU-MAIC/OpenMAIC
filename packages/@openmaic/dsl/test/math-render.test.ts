import { describe, expect, it } from 'vitest';
import {
  MATH_MACRO_DEFINITION_COMMANDS,
  SAFE_MATH_MAX_EXPAND,
  safeKatexOptions,
} from '../src/index.js';

/** A minimal stand-in for the engines' macro context, over a token list. */
function contextOver(source: string[]) {
  const tokens = [...source];
  const take = () => ({ text: tokens.shift() ?? 'EOF' });
  const context = {
    future: () => ({ text: tokens[0] ?? 'EOF' }),
    popToken: take,
    consumeSpaces: () => {
      while (tokens[0] === ' ') tokens.shift();
    },
    consumeArg: () => {
      context.consumeSpaces();
      const first = take();
      if (first.text !== '{') return { tokens: [first] };
      const group: { text: string }[] = [];
      let depth = 1;
      while (tokens.length > 0) {
        const token = take();
        if (token.text === '{') depth += 1;
        if (token.text === '}') depth -= 1;
        if (depth === 0) break;
        group.push(token);
      }
      // The engines return argument tokens in stack order (last first).
      return { tokens: group.reverse() };
    },
    defined: new Map<string, unknown>(),
    macros: {
      set: (name: string, value: unknown) => {
        context.defined.set(name, value);
      },
    },
  };
  return { context, rest: () => tokens.join('') };
}

type Expansion = { tokens: { text: string }[]; numArgs: number };

/** Replacement text of a stored macro value, read in source order. */
function textOf(expansion: Expansion): string {
  return [...expansion.tokens]
    .reverse()
    .map((token) => token.text)
    .join('');
}

/** Runs an inert definition; each one expands to `\relax` plus what it left unread. */
function expandWithState(command: string, source: string[]) {
  const macro = safeKatexOptions().macros[command];
  const { context, rest } = contextOver(source);
  const replacement = typeof macro === 'function' ? macro(context) : macro;
  const defined = Object.fromEntries(
    [...context.defined].map(([name, value]) => [
      name,
      typeof value === 'function'
        ? [textOf(value() as Expansion), textOf(value() as Expansion)]
        : textOf(value as Expansion),
    ]),
  );
  return { output: replacement + rest(), defined };
}

function expand(command: string, source: string[]): string {
  return expandWithState(command, source).output;
}

describe('safeKatexOptions', () => {
  it('keeps caller options and forces the hardened ones', () => {
    const options = safeKatexOptions({
      displayMode: true,
      output: 'html',
      throwOnError: false,
      strict: false,
      trust: true,
      maxExpand: Infinity,
    });
    expect(options).toMatchObject({
      displayMode: true,
      output: 'html',
      throwOnError: false,
      strict: false,
      trust: false,
      maxExpand: SAFE_MATH_MAX_EXPAND,
    });
  });

  it('lets a caller lower the expansion budget but not raise it', () => {
    expect(safeKatexOptions({ maxExpand: 10 }).maxExpand).toBe(10);
    expect(safeKatexOptions({ maxExpand: 1e6 }).maxExpand).toBe(SAFE_MATH_MAX_EXPAND);
    expect(safeKatexOptions().maxExpand).toBe(SAFE_MATH_MAX_EXPAND);
  });

  it('replaces every macro-defining command', () => {
    const { macros } = safeKatexOptions();
    for (const command of MATH_MACRO_DEFINITION_COMMANDS) {
      expect(macros, command).toHaveProperty([command]);
    }
  });

  it('builds a fresh macros object per call and never writes to the caller’s', () => {
    const own = { '\\R': '\\mathbb{R}' };
    const first = safeKatexOptions({ macros: own });
    const second = safeKatexOptions({ macros: own });
    expect(first.macros).not.toBe(second.macros);
    expect(first.macros).not.toBe(own);
    expect(first.macros['\\R']).toBe('\\mathbb{R}');
    first.macros['\\leaked'] = 'x';
    expect(second.macros).not.toHaveProperty(['\\leaked']);
    expect(own).toEqual({ '\\R': '\\mathbb{R}' });
  });

  it('does not let caller macros re-enable a definition command', () => {
    const { macros } = safeKatexOptions({ macros: { '\\def': '\\relax', '\\R': 'R' } });
    expect(macros['\\def']).not.toBe('\\relax');
    expect(macros['\\R']).toBe('R');
  });

  describe('inert definitions consume the whole definition', () => {
    it('\\def with parameters', () => {
      expect(expand('\\def', ['\\x', '#', '1', '{', 'a', '{', 'b', '}', '}', 'y'])).toBe('y');
    });
    it('\\def at the end of input', () => {
      expect(expand('\\def', [])).toBe('');
      expect(expand('\\def', ['\\x', '#'])).toBe('');
    });
    it('\\newcommand with argument count and default', () => {
      expect(
        expand('\\newcommand', ['{', '\\x', '}', '[', '2', ']', '[', 'd', ']', '{', 'b', '}', 'y']),
      ).toBe('y');
      expect(expand('\\renewcommand', ['\\x', '{', 'b', '}', 'y'])).toBe('y');
    });
    it('\\newcommand keeps a braced "[" body as the body', () => {
      expect(expand('\\newcommand', ['{', '\\a', '}', '{', '[', '}', 'x', ']', '+', 'y'])).toBe(
        'x]+y',
      );
    });
    it('\\newcommand* and braced "]" inside an optional default', () => {
      expect(expand('\\newcommand', ['*', '\\a', '{', 'B', '}', '+', 'z'])).toBe('+z');
      expect(
        expand('\\newcommand', ['\\a', '[', '1', ']', '[', '{', ']', '}', ']', '{', 'B', '}', 'z']),
      ).toBe('z');
    });
    it('\\let with and without "="', () => {
      expect(expand('\\let', ['\\x', ' ', '=', ' ', '\\frac', 'y'])).toBe('y');
      expect(expand('\\let', ['\\x', '\\frac', 'y'])).toBe('y');
      expect(expand('\\let', [])).toBe('');
    });
    it('\\futurelet keeps the two following tokens', () => {
      expect(expand('\\futurelet', ['\\x', 'a', 'b'])).toBe('ab');
    });
    it('prefixes are dropped', () => {
      expect(expand('\\global', ['y'])).toBe('y');
      expect(expand('\\long', ['y'])).toBe('y');
    });
  });

  describe('\\gdef sets only the built-in equation-numbering state', () => {
    const tagBody = (...inner: string[]) => ['{', '\\text', '{', ...inner, '}', '}'];

    it('accepts the shapes that \\tag, \\tag*, and \\nonumber expand to', () => {
      expect(
        expandWithState('\\gdef', ['\\df@tag', ...tagBody('(', '{', '1', '}', ')'), 'y']),
      ).toEqual({
        output: 'y',
        // The full tag expands once; later mentions yield an empty `\text{}`.
        defined: { '\\df@tag': ['\\text{({1})}', '\\text{}'] },
      });
      expect(expandWithState('\\gdef', ['\\df@tag', ...tagBody('a'), 'y'])).toEqual({
        output: 'y',
        defined: { '\\df@tag': ['\\text{a}', '\\text{}'] },
      });
      expect(expandWithState('\\gdef', ['\\@eqnsw', '{', '0', '}', 'y'])).toEqual({
        output: 'y',
        defined: { '\\@eqnsw': '0' },
      });
    });

    it.each([
      ['any other name', ['\\ma', ...tagBody('a')]],
      ['a self-referencing tag', ['\\df@tag', ...tagBody('\\df@tag', 'x')]],
      ['a nested self-reference', ['\\df@tag', ...tagBody('{', '\\df@tag', '}')]],
      ['a tag that is not one \\text group', ['\\df@tag', '{', 'x', '}']],
      ['a tag with text after the group', ['\\df@tag', '{', '\\text', '{', 'a', '}', 'b', '}']],
      ['a tag with parameters', ['\\df@tag', '#', '1', ...tagBody('#', '1')]],
      ['\\@eqnsw set to anything but 0', ['\\@eqnsw', '{', '1', '}']],
      ['a recursive \\@eqnsw', ['\\@eqnsw', '{', '\\@eqnsw', '\\@eqnsw', '}']],
    ])('swallows %s without defining anything', (_name, definition) => {
      expect(expandWithState('\\gdef', [...definition, 'y'])).toEqual({ output: 'y', defined: {} });
    });

    it('keeps every other definition command inert for the state names', () => {
      for (const command of ['\\def', '\\edef', '\\xdef']) {
        expect(expandWithState(command, ['\\df@tag', ...tagBody('a'), 'y']), command).toEqual({
          output: 'y',
          defined: {},
        });
      }
    });
  });
});
