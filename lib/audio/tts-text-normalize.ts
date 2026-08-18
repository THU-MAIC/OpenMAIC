/**
 * Spoken-text normalization for TTS synthesis.
 *
 * Third-party TTS engines read raw narration/discussion text literally, so a scene
 * whose script still holds LaTeX math (`$...$`, `$$...$$`, `\frac{a}{b}`, `^`, `_`)
 * gets the `$` delimiters and math tokens read aloud ("issue #394"). This module
 * converts those math spans and unambiguous LaTeX command tokens into a spoken,
 * pronounceable form before the text reaches the provider.
 *
 * Design rules (see docs/plans/2026-08-18-002-fix-chinese-tts-latex-narration-plan.md):
 * - Pair-delimited math spans (`$$...$$` / `$...$`) are normalized only when the
 *   delimiters are paired AND the inner content looks like math. A lone/unpaired
 *   `$` (e.g. currency "$100") stays literal.
 * - Outside math spans, only unambiguous backslash laTeX command tokens are
 *   translated (`\frac`, `\times`, `\cdot`, `\leq`, ...). Bare prose symbols
 *   (`+`, `-`, `%`, `×`, "3+4", "C++") are never rewritten.
 * - Ordinary prose with no math signal is returned byte-identical (no regression).
 */

/** Fractions: `\frac{num}{den}` -> "num 分之 den". Order matters: run before symbol passes. */
const FRACTION_RE = /\\[a-z]*frac\??\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;

/** Unambiguous multiplication/division command tokens (also translated outside spans). */
const MUL_DIV_CMD_RE = /\\times|\\cdot|\\ast|\\div/g;

/** Comparison command tokens (also translated outside spans). */
const COMPARE_CMD_RE = /\\leq|\\leqslant|\\le|\\geq|\\geqslant|\\ge|\\neq|\\ne|\\approx|\\equiv/g;

/** Greek/letters worth pronouncing; everything else backslashed that survives is dropped. */
const GREEK_CMD_RE =
  /\\alpha|\\beta|\\gamma|\\delta|\\epsilon|\\lambda|\\mu|\\pi|\\theta|\\sigma|\\omega|\\phi/g;

/** `^{...}` or `^x` superscript. */
const SUPER_GROUP_RE = /\^\{([^{}]*)\}/g;
const SUPER_CHAR_RE = /\^([0-9A-Za-z])/g;
/** `_{...}` or `_x` subscript. */
const SUB_GROUP_RE = /_\{([^{}]*)\}/g;
const SUB_CHAR_RE = /_([0-9A-Za-z])/g;

/** `\sqrt{...}` */
const SQRT_RE = /\\sqrt\s*\{([^{}]*)\}/g;

/** Scaffolding braces and sizes we never want spoken. */
const NOISE_RE = /\\left|\\right|\\big|\\Big|\\bigl|\\bigr|\{|\}|\\;/g;

const GREEK_WORDS: Record<string, string> = {
  alpha: '阿尔法',
  beta: '贝塔',
  gamma: '伽马',
  delta: '德尔塔',
  epsilon: '艾普西龙',
  lambda: '兰布达',
  mu: '谬',
  pi: 'π',
  theta: '西塔',
  sigma: '西格玛',
  omega: '欧米伽',
  phi: '斐',
};

/** Spoken form of a superscript exponent. */
function exponentWord(inner: string): string {
  const text = inner.trim();
  if (text === '2') return '的平方';
  if (text === '3') return '的立方';
  return `的 ${text} 次方`;
}

/**
 * Convert raw LaTeX/ASCII math to a spoken, pronounceable form.
 *
 * Intended for the interior of a recognized math span, where bare math symbols
 * (`=`, `+`, `%`, ...) are meaningful and safe to translate.
 */
function speakMath(latex: string): string {
  const out = latex
    .replace(FRACTION_RE, '$1 分之 $2')
    .replace(MUL_DIV_CMD_RE, (m) => (m === '\\div' ? '除以' : '乘以'))
    .replace(COMPARE_CMD_RE, (m) => {
      switch (m) {
        case '\\leq':
        case '\\leqslant':
        case '\\le':
          return '小于等于';
        case '\\geq':
        case '\\geqslant':
        case '\\ge':
          return '大于等于';
        case '\\neq':
        case '\\ne':
          return '不等于';
        default:
          return '约等于';
      }
    })
    .replace(GREEK_CMD_RE, (m) => GREEK_WORDS[m.slice(1)] ?? '')
    .replace(SUPER_GROUP_RE, (_, inner: string) => exponentWord(inner))
    .replace(SUPER_CHAR_RE, (_, c: string) => exponentWord(c))
    .replace(SUB_GROUP_RE, (_, inner: string) => ` 下标 ${inner} `)
    .replace(SUB_CHAR_RE, (_, c: string) => ` 下标 ${c} `)
    .replace(SQRT_RE, '根号 $1')
    .replace(NOISE_RE, ' ')
    .replace(/%/g, '百分之')
    .replace(/÷|×/g, (m) => (m === '÷' ? '除以' : '乘以'))
    .replace(/≤/g, '小于等于')
    .replace(/≥/g, '大于等于')
    .replace(/≠/g, '不等于')
    .replace(/=/g, '等于')
    .replace(/\+/g, ' 加 ')
    .replace(/-(?=[\d])/g, '减')
    .replace(/\\(?!\s)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return out;
}

/** Translate only unambiguous backslash LaTeX command tokens in ordinary prose. */
function speakBareLatexCommands(text: string): string {
  return text
    .replace(FRACTION_RE, '$1 分之 $2')
    .replace(MUL_DIV_CMD_RE, (m) => (m === '\\div' ? '除以' : '乘以'))
    .replace(COMPARE_CMD_RE, (m) => {
      switch (m) {
        case '\\leq':
        case '\\leqslant':
        case '\\le':
          return '小于等于';
        case '\\geq':
        case '\\geqslant':
        case '\\ge':
          return '大于等于';
        case '\\neq':
        case '\\ne':
          return '不等于';
        default:
          return '约等于';
      }
    })
    .replace(GREEK_CMD_RE, (m) => GREEK_WORDS[m.slice(1)] ?? '')
    .replace(SQRT_RE, '根号 $1')
    .replace(/\\(?!\s)/g, ' ')
    .replace(/\s{2,}/g, ' ');
}

/** Heuristic: does a `$...$` interior look like math rather than prose/currency? */
function looksLikeMath(inner: string): boolean {
  const text = inner.trim();
  if (!text) return false;
  if (/\\[a-zA-Z]/.test(text)) return true; // laTeX command present
  if (/[=<>≤≥≈^_√]/.test(text)) return true; // equation / power / root signal
  if (/^[\d+\-*/().% ]+$/.test(text) && /[\d]/.test(text)) return true; // arithmetic like "1+2"
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(text) && text.length <= 4) return true; // short token like "E", "mc"
  return false;
}

/** Number of consecutive backslashes immediately before `index` is odd? */
function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function findNextUnescaped(value: string, char: string, from: number): number {
  let index = value.indexOf(char, from);
  while (index !== -1) {
    if (!isEscaped(value, index)) return index;
    index = value.indexOf(char, index + 1);
  }
  return -1;
}

/** Replace paired, math-looking single-`$` inline spans; leave lone/currency `$` literal. */
function replaceInlineMathSpans(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && !isEscaped(text, i)) {
      const close = findNextUnescaped(text, '$', i + 1);
      if (close !== -1) {
        const inner = text.slice(i + 1, close);
        if (looksLikeMath(inner)) {
          result += speakMath(inner);
          i = close + 1;
          continue;
        }
      }
    }
    result += text[i];
    i += 1;
  }
  return result;
}

/**
 * Normalize narration/discussion text into a TTS-readable spoken form before it
 * reaches a synthesis provider. Returns the input unchanged when it contains no
 * math signal.
 */
export function normalizeSpokenText(text: string): string {
  if (!text) return '';

  // 1. Display math: `$$...$$`
  const afterDisplay = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner: string) => speakMath(inner));

  // 2. Inline math: paired `$...$` that actually looks like math
  const afterInline = replaceInlineMathSpans(afterDisplay);

  // 3. Outside spans: translate only unambiguous backslash command tokens
  return speakBareLatexCommands(afterInline);
}
