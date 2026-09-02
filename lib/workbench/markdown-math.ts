import { math } from 'micromark-extension-math';

const FORMULA_CHAR_RE = /^[\s0-9A-Za-z\p{Script=Greek}\\{}()[\]^_+\-*/=<>≤≥≈.,:;'|!%√]+$/u;
const LATEX_COMMAND_RE = /\\(?:[A-Za-z]+|[%{}_$#&])/;
const UNICODE_MATH_SYMBOL_RE = /(?=[^\x00-\x7f])\p{Sm}/u;
const LONG_WORD_RE = /[A-Za-z]{3,}/g;
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const SINGLE_SYMBOL_RE = /^(?:[A-Za-z]|\p{Script=Greek})$/u;
const EQUATION_OR_SCRIPT_RE = /[=<>≤≥≈^_]/;
const COMPLETE_OPERATOR_RE =
  /[A-Za-z0-9\p{Script=Greek})\]}]\s*[+\-*/]\s*[A-Za-z0-9\p{Script=Greek}({\\]/u;
const FUNCTION_OR_GROUP_RE = /[([{|].*[)\]}|]/;
const MONOMIAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)?[A-Za-z\p{Script=Greek}]{1,3}\d*$/u;
const NUMERIC_ATOM_RE = /^\d+(?:\.\d+)?$/;
const NUMERIC_POSTFIX_RE = /^\d+(?:\.\d+)?[!']+$/;
const BARE_SHELL_ENV_FRAGMENT_RE = /^(?:[A-Z][A-Z0-9_]*|[A-Z][A-Z0-9_]+\S+)$/;
const BRACED_SHELL_FRAGMENT_RE = /^\{[^{}\s]+\}\S*$/;
const PAREN_SHELL_FRAGMENT_RE = /^\(.+\)\S*$/;
const ASCII_TOKEN_RE = /[A-Za-z0-9_\\]/;
const SHELL_TOKEN_RE = /[A-Za-z0-9_({\\]/;
const STRONG_SHELL_TOKEN_RE = /[A-Z0-9_({\\]/;
const TRAILING_OPERATOR_RE = /[+\-*/=<>≤≥≈^_]$/;
const SCRIPT_OPERATOR_RE = /[\^_][+\-*/]$/;
const SEQUENCE_EXPRESSION_RE = /[^,:\s]\s*[,:]\s*[^,:\s]/;
const POSTFIX_OPERATOR_RE = /[A-Za-z0-9\p{Script=Greek})\]}][!']+$/u;

/**
 * Single-dollar Markdown is inherently ambiguous. Keep the accepted subset
 * deliberately formula-shaped; ordinary prose must remain literal text.
 */
function isLikelySingleDollarMath(value: string, nextCharacter = ''): boolean {
  const text = value.trim();
  if (!text || text !== value) return false;

  // A parsed closer can actually be the opener of an adjacent currency or
  // shell token. Keep common prose suffixes such as `$n$th` working.
  if (
    (NUMERIC_ATOM_RE.test(text) || NUMERIC_POSTFIX_RE.test(text)) &&
    ASCII_TOKEN_RE.test(nextCharacter)
  ) {
    return false;
  }
  if (BARE_SHELL_ENV_FRAGMENT_RE.test(text) && STRONG_SHELL_TOKEN_RE.test(nextCharacter)) {
    return false;
  }
  if (BRACED_SHELL_FRAGMENT_RE.test(text) && SHELL_TOKEN_RE.test(nextCharacter)) return false;
  if (PAREN_SHELL_FRAGMENT_RE.test(text) && STRONG_SHELL_TOKEN_RE.test(nextCharacter)) return false;
  if (TRAILING_OPERATOR_RE.test(text) && !SCRIPT_OPERATOR_RE.test(text)) return false;

  // Explicit LaTeX commands are a stronger signal than the character guard:
  // text-like commands intentionally contain spaces and Unicode prose.
  if (LATEX_COMMAND_RE.test(text) || UNICODE_MATH_SYMBOL_RE.test(text)) return true;
  if (!FORMULA_CHAR_RE.test(text)) return false;
  if (NUMBER_RE.test(text) || SINGLE_SYMBOL_RE.test(text)) return true;
  if (EQUATION_OR_SCRIPT_RE.test(text)) return true;

  const proseWords = text.match(LONG_WORD_RE) ?? [];
  if (proseWords.length > 1) return false;

  if (COMPLETE_OPERATOR_RE.test(text)) return true;
  if (FUNCTION_OR_GROUP_RE.test(text)) return true;
  if (proseWords.length === 0 && SEQUENCE_EXPRESSION_RE.test(text)) return true;
  if (proseWords.length === 0 && POSTFIX_OPERATOR_RE.test(text)) return true;
  return MONOMIAL_RE.test(text);
}

function normalizeMathTextPadding(value: string): string {
  const leading = value.match(/^(?: |\r\n|[\r\n])/);
  const trailing = value.match(/(?: |\r\n|[\r\n])$/);

  // micromark removes one symmetric space/line ending around non-empty math.
  if (!leading || !trailing || !/[^ \r\n]/.test(value)) return value;
  return value.slice(leading[0].length, value.length - trailing[0].length);
}

const officialMathText = math({ singleDollarTextMath: true }).text?.[36];

if (!officialMathText || Array.isArray(officialMathText)) {
  throw new Error('Expected the official math-text tokenizer');
}

const selectiveSingleDollarMathText: typeof officialMathText = {
  ...officialMathText,
  name: 'workbenchSingleDollarMathText',
  tokenize(effects, ok, nok) {
    let mathTextToken: ReturnType<typeof effects.enter> | undefined;
    const guardedEffects: typeof effects = {
      ...effects,
      enter(type, fields) {
        const token = effects.enter(type, fields);
        if (type === 'mathText') mathTextToken = token;
        return token;
      },
    };

    const acceptIfFormulaShaped: typeof ok = (code) => {
      if (!mathTextToken) return nok(code);

      const raw = this.sliceSerialize(mathTextToken);
      const singleDollar =
        raw[0] === '$' && raw[1] !== '$' && raw.at(-1) === '$' && raw.at(-2) !== '$';
      const nextCharacter = typeof code === 'number' && code >= 0 ? String.fromCodePoint(code) : '';

      const value = normalizeMathTextPadding(raw.slice(1, -1));

      return singleDollar && isLikelySingleDollarMath(value, nextCharacter) ? ok(code) : nok(code);
    };

    return officialMathText.tokenize.call(this, guardedEffects, acceptIfFormulaShaped, nok);
  },
};

interface MarkdownProcessor {
  data(): object;
}

/**
 * Adds formula-aware single-dollar math to the same micromark parser used by
 * Streamdown. Rejected candidates roll back as ordinary Markdown text, so the
 * next dollar is considered without source rewriting or reparsing.
 */
export function remarkSelectiveSingleDollarMath(this: MarkdownProcessor): void {
  const data = this.data() as { micromarkExtensions?: ReturnType<typeof math>[] };
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = []);
  extensions.push({ text: { [36]: selectiveSingleDollarMathText } });
}
