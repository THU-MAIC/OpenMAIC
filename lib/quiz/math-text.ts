import katex from 'katex';

export type QuizMathTextSegment =
  | {
      type: 'text';
      value: string;
    }
  | {
      type: 'math';
      value: string;
      html: string;
      displayMode: boolean;
    };

interface Delimiter {
  open: string;
  close: string;
  displayMode: boolean;
}

const DELIMITERS: Delimiter[] = [
  { open: '$$', close: '$$', displayMode: true },
  { open: '\\[', close: '\\]', displayMode: true },
  { open: '\\(', close: '\\)', displayMode: false },
  { open: '$', close: '$', displayMode: false },
];

const LATEX_COMMAND_RE = /\\[a-zA-Z]+/;
const LATEX_COMMAND_GLOBAL_RE = /\\[a-zA-Z]+/g;
const INLINE_OPERATOR_RE = /[A-Za-z0-9)\]}]\s*[+\-*/]\s*[A-Za-z0-9({\\]/;
const FORMULA_CHAR_RE = /^[\s0-9A-Za-z\\{}()[\]^_+\-*/=<>≤≥≈.,:;|!%√πθαβγδελμνρσφωΑΒΓΔΘΛΜΝΠΡΣΦΩ]+$/;
const WORD_RE = /[A-Za-z]{3,}/g;
const EXPLICIT_DELIMITER_RE = /\\\[|\\\(|(?:^|[^\\])\$\$?/;
const LETTER_OR_COMMAND_RE = /[A-Za-z\\πθαβγδελμνρσφωΑΒΓΔΘΛΜΝΠΡΣΦΩ]/;
const EQUATION_OR_POWER_RE = /[=<>≤≥≈^_]/;
const SINGLE_SYMBOL_RE = /^(?:[A-Za-z]|\\[a-zA-Z]+|\d+(?:\.\d+)?)$/;
const CODE_LIKE_BOOLEAN_ASSIGNMENT_RE =
  /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:true|false|null|undefined|none)$/i;
const CODE_LIKE_INCREMENT_RE = /^([ijk])\s*=\s*\1\s*[+-]\s*1$/i;
const SENTENCE_BOUNDARY_CHAR_RE = /^[.,!?;:]$/;
const TOKEN_RE = /\S+/g;

export function isLikelyStandaloneMathText(value: string): boolean {
  const text = value.trim();
  if (text.length < 3) return false;
  if (!FORMULA_CHAR_RE.test(text)) return false;
  if (!LETTER_OR_COMMAND_RE.test(text) && !EQUATION_OR_POWER_RE.test(text)) return false;
  if (!LATEX_COMMAND_RE.test(text) && !EQUATION_OR_POWER_RE.test(text)) return false;

  const proseWords = text.replace(LATEX_COMMAND_GLOBAL_RE, ' ').match(WORD_RE) ?? [];
  if (proseWords.length > 0) return false;
  if (isCodeLikeAssignment(text)) return false;

  return true;
}

export function renderLatexToHtml(value: string, displayMode = false): string | null {
  try {
    return katex.renderToString(escapeLiteralPercents(value), {
      displayMode,
      output: 'html',
      strict: false,
      throwOnError: true,
    });
  } catch {
    return null;
  }
}

function escapeLiteralPercents(value: string): string {
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') {
      escaped += value[index];
      continue;
    }

    escaped += isEscaped(value, index) ? '%' : '\\%';
  }
  return escaped;
}

export function parseQuizMathText(value: string): QuizMathTextSegment[] {
  const segments: QuizMathTextSegment[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const opening = findNextDelimiter(value, cursor);
    if (!opening) break;

    if (opening.index > cursor) {
      segments.push({ type: 'text', value: value.slice(cursor, opening.index) });
    }

    const mathStart = opening.index + opening.delimiter.open.length;
    const closeIndex = findClosingDelimiter(value, opening.delimiter.close, mathStart);
    if (closeIndex === -1) {
      segments.push({ type: 'text', value: value.slice(opening.index) });
      cursor = value.length;
      break;
    }

    const latex = value.slice(mathStart, closeIndex).trim();
    if (latex) {
      const shouldRender = opening.delimiter.open !== '$' || isLikelyDelimitedMathText(latex);
      const html = shouldRender ? renderLatexToHtml(latex, opening.delimiter.displayMode) : null;
      if (html) {
        segments.push({
          type: 'math',
          value: latex,
          html,
          displayMode: opening.delimiter.displayMode,
        });
      } else {
        segments.push({
          type: 'text',
          value: value.slice(opening.index, closeIndex + opening.delimiter.close.length),
        });
      }
    } else {
      segments.push({
        type: 'text',
        value: value.slice(opening.index, closeIndex + opening.delimiter.close.length),
      });
    }

    cursor = closeIndex + opening.delimiter.close.length;
  }

  if (cursor < value.length) {
    segments.push({ type: 'text', value: value.slice(cursor) });
  }

  return mergeTextSegments(segments);
}

function parseEmbeddedMathText(value: string): QuizMathTextSegment[] | null {
  const segments: QuizMathTextSegment[] = [];
  let cursor = 0;
  let hasMath = false;
  TOKEN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(value)) !== null) {
    const tokenStart = match.index;
    const tokenEnd = tokenStart + match[0].length;
    const candidate = trimEmbeddedMathCandidate(value, tokenStart, tokenEnd);
    if (!candidate || candidate.start < cursor) continue;
    if (!isLikelyEmbeddedMathText(candidate.value)) continue;

    const html = renderLatexToHtml(candidate.value, false);
    if (!html) continue;

    if (candidate.start > cursor) {
      segments.push({ type: 'text', value: value.slice(cursor, candidate.start) });
    }

    segments.push({
      type: 'math',
      value: candidate.value,
      html,
      displayMode: false,
    });
    hasMath = true;
    cursor = candidate.end;
  }

  if (!hasMath) return null;
  if (cursor < value.length) {
    segments.push({ type: 'text', value: value.slice(cursor) });
  }

  return mergeTextSegments(segments);
}

function trimEmbeddedMathCandidate(
  value: string,
  start: number,
  end: number,
): { start: number; end: number; value: string } | null {
  let candidateStart = start;
  let candidateEnd = end;

  while (candidateStart < candidateEnd && /["'“”‘’]/.test(value[candidateStart])) {
    candidateStart += 1;
  }

  while (candidateEnd > candidateStart && SENTENCE_BOUNDARY_CHAR_RE.test(value[candidateEnd - 1])) {
    candidateEnd -= 1;
  }

  const candidate = value.slice(candidateStart, candidateEnd);
  if (!candidate) return null;
  return { start: candidateStart, end: candidateEnd, value: candidate };
}

function isLikelyEmbeddedMathText(value: string): boolean {
  const text = value.trim();
  if (text.length < 6) return false;
  if (!FORMULA_CHAR_RE.test(text)) return false;
  if (!LETTER_OR_COMMAND_RE.test(text)) return false;
  if (isCodeLikeAssignment(text)) return false;

  const proseWords = text.replace(LATEX_COMMAND_GLOBAL_RE, ' ').match(WORD_RE) ?? [];
  if (proseWords.length > 0) return false;
  if (!EQUATION_OR_POWER_RE.test(text)) return false;

  return INLINE_OPERATOR_RE.test(text) || LATEX_COMMAND_RE.test(text) || text.length >= 12;
}

function isLikelyDelimitedMathText(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (!FORMULA_CHAR_RE.test(text)) return false;
  if (SINGLE_SYMBOL_RE.test(text)) return true;
  if (LATEX_COMMAND_RE.test(text) || EQUATION_OR_POWER_RE.test(text)) return true;
  if (INLINE_OPERATOR_RE.test(text) && (text.match(WORD_RE) ?? []).length <= 1) return true;
  return false;
}

export function renderQuizMathText(value: string): QuizMathTextSegment[] {
  const likelyStandalone = isLikelyStandaloneMathText(value);
  const hasExplicitDelimiter = EXPLICIT_DELIMITER_RE.test(value);

  if (!hasExplicitDelimiter && !likelyStandalone) {
    return parseEmbeddedMathText(value) ?? [{ type: 'text', value }];
  }

  const delimited = parseQuizMathText(value);
  if (delimited.some((segment) => segment.type === 'math')) return delimited;

  if (!likelyStandalone) return [{ type: 'text', value }];

  const latex = value.trim();
  const html = renderLatexToHtml(latex, false);
  if (!html) return [{ type: 'text', value }];

  const prefix = value.slice(0, value.indexOf(latex));
  const suffix = value.slice(value.indexOf(latex) + latex.length);

  return mergeTextSegments([
    ...(prefix ? ([{ type: 'text', value: prefix }] as QuizMathTextSegment[]) : []),
    { type: 'math', value: latex, html, displayMode: false },
    ...(suffix ? ([{ type: 'text', value: suffix }] as QuizMathTextSegment[]) : []),
  ]);
}

function findNextDelimiter(
  value: string,
  startIndex: number,
): { delimiter: Delimiter; index: number } | null {
  let match: { delimiter: Delimiter; index: number } | null = null;

  for (const delimiter of DELIMITERS) {
    const index = findUnescaped(value, delimiter.open, startIndex);
    if (index === -1) continue;
    if (
      !match ||
      index < match.index ||
      (index === match.index && delimiter.open.length > match.delimiter.open.length)
    ) {
      match = { delimiter, index };
    }
  }

  return match;
}

function findClosingDelimiter(value: string, delimiter: string, startIndex: number): number {
  return findUnescaped(value, delimiter, startIndex);
}

function findUnescaped(value: string, search: string, startIndex: number): number {
  let index = value.indexOf(search, startIndex);
  while (index !== -1) {
    if (!isEscaped(value, index)) return index;
    index = value.indexOf(search, index + search.length);
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isCodeLikeAssignment(value: string): boolean {
  const text = value.trim();
  return CODE_LIKE_BOOLEAN_ASSIGNMENT_RE.test(text) || CODE_LIKE_INCREMENT_RE.test(text);
}

function mergeTextSegments(segments: QuizMathTextSegment[]): QuizMathTextSegment[] {
  const merged: QuizMathTextSegment[] = [];

  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (segment.type === 'text' && last?.type === 'text') {
      last.value += segment.value;
    } else if (segment.type === 'text' && segment.value === '') {
      continue;
    } else {
      merged.push(segment);
    }
  }

  return merged.length > 0 ? merged : [{ type: 'text', value: '' }];
}
