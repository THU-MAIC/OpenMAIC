/**
 * Inline formula pairing for narrated speech:
 *
 *   "导数的定义是 [[$f'(x) = \\lim_{\\Delta x \\to 0} \\frac{\\Delta y}{\\Delta x}$ | f 撇 x 等于，当德尔塔 x 趋近于零时，德尔塔 y 比德尔塔 x 的极限]]。"
 *
 * Splits a single LLM-authored string into two synchronized views:
 *   - `text`: display caption with clean `$...$` inline math for KaTeX rendering
 *   - `spokenText`: TTS-ready spoken reading (only set when it differs from `text`)
 */

export interface SpeechFormulaViews {
  text: string;
  spokenText?: string;
}

/**
 * Recover LaTeX commands inside math spans whose leading backslash was
 * consumed as a C-style JSON escape (`\f` -> form feed, `\b` -> backspace,
 * `\t` -> tab, `\r` -> CR, `\n` -> LF) when the model wrote single backslashes
 * inside a JSON string.
 */
export function recoverJsonLatexEscapes(math: string): string {
  return (
    math
      // \x08 (\b): \beta, \bar, \binom, \boxed, \begin, \because, \bmod, \mathbf...
      .replace(/\x08([A-Za-z])/g, '\\b$1')
      // \x0c (\f): \frac, \forall...
      .replace(/\x0c([A-Za-z])/g, '\\f$1')
      // \x09 (\t): common TeX commands starting with t
      .replace(
        /\t(frac\b|ext(?:bf|it|rm)?\b|imes\b|heta\b|au\b|anh?\b|o\b|op\b|riangle\b|ilde\b|herefore\b)/g,
        '\\t$1',
      )
      // \x0d (\r): \rightarrow, \right, \rho, \rceil, \rfloor
      .replace(/\r(ight(?:arrow)?\b|ho\b|ceil\b|floor\b)/g, '\\r$1')
      // \x0a (\n): \neq, \ne, \nu, \nabla, \notin, \natural, \neg
      .replace(/\n(eq?\b|u\b|abla\b|otin\b|atural\b|eg\b)/g, '\\n$1')
  );
}

function isEscapedAt(source: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function findUnescapedDollar(source: string, delim: '$' | '$$', from: number): number {
  let idx = source.indexOf(delim, from);
  while (idx !== -1) {
    if (!isEscapedAt(source, idx)) {
      if (delim === '$$' || source[idx + 1] !== '$') return idx;
    }
    idx = source.indexOf(delim, idx + delim.length);
  }
  return -1;
}

function recoverBareDollarEscapes(segment: string): string {
  if (
    !segment.includes('\x08') &&
    !segment.includes('\x0c') &&
    !segment.includes('\t') &&
    !segment.includes('\r') &&
    !segment.includes('\n')
  ) {
    return segment;
  }
  let out = '';
  let cursor = 0;
  while (cursor < segment.length) {
    const start = findUnescapedDollar(segment, '$', cursor);
    if (start === -1) {
      out += segment.slice(cursor);
      break;
    }
    const delim: '$' | '$$' = segment[start + 1] === '$' ? '$$' : '$';
    const end = findUnescapedDollar(segment, delim, start + delim.length);
    if (end === -1) {
      out += segment.slice(cursor);
      break;
    }
    out += segment.slice(cursor, start);
    out += recoverJsonLatexEscapes(segment.slice(start, end + delim.length));
    cursor = end + delim.length;
  }
  return out;
}

function appendSpoken(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  const last = prev[prev.length - 1];
  const first = next[0];
  if (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(first)) {
    return `${prev} ${next}`;
  }
  return prev + next;
}

/**
 * Split inline `[[$LaTeX$ | spoken]]` pairs into display `text` and TTS `spokenText`.
 *
 * Safe on ordinary text with no pairs (`text` is trimmed input, `spokenText` is `undefined`).
 * Ignores `|` and `]]` inside `$...$` (so absolute values `$|x - 1|$` and matrix
 * brackets `\begin{bmatrix}` never break the split).
 */
export function splitSpeechFormulaPairs(raw: string): SpeechFormulaViews {
  const input = raw.trim();
  if (!input) return { text: '' };
  if (!input.includes('[[')) {
    return { text: recoverBareDollarEscapes(input) };
  }

  let displayOut = '';
  let spokenOut = '';
  let cursor = 0;

  while (cursor < input.length) {
    const open = input.indexOf('[[', cursor);
    if (open === -1) {
      const tail = recoverBareDollarEscapes(input.slice(cursor));
      displayOut += tail;
      spokenOut = appendSpoken(spokenOut, tail);
      break;
    }

    const prefix = recoverBareDollarEscapes(input.slice(cursor, open));
    displayOut += prefix;
    spokenOut = appendSpoken(spokenOut, prefix);

    let j = open + 2;
    while (j < input.length && (input[j] === ' ' || input[j] === '\t')) j++;

    let matched = false;
    if (input[j] === '$') {
      const delim: '$' | '$$' = input[j + 1] === '$' ? '$$' : '$';
      const mathEnd = findUnescapedDollar(input, delim, j + delim.length);
      if (mathEnd !== -1) {
        const latexWithDollars = recoverJsonLatexEscapes(input.slice(j, mathEnd + delim.length));
        let k = mathEnd + delim.length;
        while (k < input.length && (input[k] === ' ' || input[k] === '\t')) k++;

        if (input[k] === '|') {
          const close = input.indexOf(']]', k + 1);
          if (close !== -1) {
            const spokenPart = input.slice(k + 1, close).trim();
            displayOut += latexWithDollars;
            spokenOut = appendSpoken(spokenOut, spokenPart || latexWithDollars);
            cursor = close + 2;
            matched = true;
          }
        } else if (input.startsWith(']]', k)) {
          // Model wrote `[[$x^2$]]` without `| spoken`: unwrap brackets cleanly.
          displayOut += latexWithDollars;
          spokenOut = appendSpoken(spokenOut, latexWithDollars);
          cursor = k + 2;
          matched = true;
        }
      }
    } else {
      // Fallback when `$...$` was omitted around the left side: `[[\frac{a}{b} | b 分之 a]]`
      const close = input.indexOf(']]', j);
      if (close !== -1) {
        const inner = input.slice(j, close);
        if (!inner.includes('[[') && !inner.includes('\n')) {
          let lastPipe = -1;
          for (let p = inner.length - 1; p >= 0; p--) {
            if (inner[p] === '|' && !isEscapedAt(inner, p)) {
              lastPipe = p;
              break;
            }
          }
          if (lastPipe > 0) {
            const rawLatex = recoverJsonLatexEscapes(inner.slice(0, lastPipe).trim());
            const spokenPart = inner.slice(lastPipe + 1).trim();
            if (rawLatex && spokenPart) {
              const wrappedLatex =
                rawLatex.startsWith('$') && rawLatex.endsWith('$') ? rawLatex : `$${rawLatex}$`;
              displayOut += wrappedLatex;
              spokenOut = appendSpoken(spokenOut, spokenPart);
              cursor = close + 2;
              matched = true;
            }
          }
        }
      }
    }

    if (!matched) {
      displayOut += '[[';
      spokenOut += '[[';
      cursor = open + 2;
    }
  }

  const text = displayOut.trim();
  const spoken = spokenOut.trim();
  return spoken && spoken !== text ? { text, spokenText: spoken } : { text };
}

/**
 * Resolve the text to send to a TTS engine for a speech action.
 * Prefers pre-split `spokenText`; also splits on the fly if `text` still carries `[[...|...]]`.
 */
export function speechForTts(action: { text?: string; spokenText?: string }): string {
  const explicit = action.spokenText?.trim();
  if (explicit) return explicit;
  const raw = action.text?.trim() ?? '';
  if (!raw) return '';
  const { text, spokenText } = splitSpeechFormulaPairs(raw);
  return spokenText || text;
}

const TEX_SYMBOL_FALLBACK: Readonly<Record<string, string>> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  Delta: 'Δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  Sigma: 'Σ',
  tau: 'τ',
  phi: 'φ',
  varphi: 'φ',
  omega: 'ω',
  Omega: 'Ω',
  infty: '∞',
  times: '×',
  cdot: '·',
  div: '÷',
  pm: '±',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  to: '→',
  rightarrow: '→',
  in: '∈',
  cup: '∪',
  cap: '∩',
  angle: '∠',
  triangle: '△',
  perp: '⊥',
};

/** Math spans retain their original delimiters. Literal prices and escaped dollars stay prose. */
export interface SpeechMathSpan {
  start: number;
  end: number;
  latex: string;
  displayMode: boolean;
}

export function speechMathSpans(text: string): SpeechMathSpan[] {
  const spans: SpeechMathSpan[] = [];
  const openings = /\$\$?|\\\(|\\\[/g;
  for (let match = openings.exec(text); match; match = openings.exec(text)) {
    const open = match[0];
    if (isEscapedAt(text, match.index)) continue;
    const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
    const from = openings.lastIndex;
    let end = text.indexOf(close, from);
    while (end !== -1 && isEscapedAt(text, end)) end = text.indexOf(close, end + close.length);
    if (end === -1) continue;
    const raw = text.slice(from, end);
    const latex = raw.trim();
    if (
      !latex ||
      (open === '$' &&
        (raw.includes('\n') ||
          /^\s+\d/.test(raw) ||
          (/^\d[\d,.]*\s+[\p{L}]/u.test(latex) &&
            (!/[\\^_={}]/.test(latex) || /\\[([]/.test(raw)))))
    )
      continue;
    openings.lastIndex = end + close.length;
    spans.push({
      start: match.index,
      end: openings.lastIndex,
      latex,
      displayMode: open === '$$' || open === '\\[',
    });
  }
  return spans;
}

/**
 * Lightweight fallback for non-MOSS TTS engines (OpenAI, Qwen, browser SpeechSynthesis)
 * when a line contains bare `$...$` without a paired `spokenText` (e.g. manual user edits).
 * MOSS does NOT use this because its Python `tn_formula.py` parses full LaTeX ASTs.
 */
export function stripInlineLatexForPlainTts(text: string): string {
  if (!text.includes('$') && !text.includes('\\')) return text;
  const hasCjk = /[\u3400-\u9fff]/.test(text);
  let result = '';
  let cursor = 0;
  for (const span of speechMathSpans(text)) {
    let s = recoverJsonLatexEscapes(span.latex);
    // \frac{a}{b} (single-level braces)
    for (let pass = 0; pass < 2; pass++) {
      s = s.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, num, den) =>
        hasCjk ? `${den} 分之 ${num}` : `${num} over ${den}`,
      );
    }
    s = s.replace(/\\sqrt\s*\[([^{}\]]+)\]\s*\{([^{}]*)\}/g, (_m, n, body) =>
      hasCjk ? `${n} 次根号下 ${body}` : `${n}th root of ${body}`,
    );
    s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_m, body) =>
      hasCjk ? `根号下 ${body}` : `square root of ${body}`,
    );
    s = s.replace(/\^\s*\\circ\b/g, hasCjk ? '度' : ' degrees');
    s = s.replace(/\^\s*\{?2\}?(?![0-9])/g, hasCjk ? ' 的平方' : ' squared');
    s = s.replace(/\^\s*\{?3\}?(?![0-9])/g, hasCjk ? ' 的立方' : ' cubed');
    s = s.replace(/\\(?:left|right|displaystyle|mathrm|mathbf|mathit|text)\b/g, '');
    s = s.replace(/\\([A-Za-z]+)/g, (_m, cmd: string) => TEX_SYMBOL_FALLBACK[cmd] ?? cmd);
    s = s.replace(/_\s*\{([^{}]*)\}/g, '($1)').replace(/_\s*([A-Za-z0-9])/g, '($1)');
    s = s.replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();
    result += text.slice(cursor, span.start) + s;
    cursor = span.end;
  }
  return result + text.slice(cursor);
}

/** Plain notes, scripts and subtitle files prefer an authored reading, including old inline pairs. */
export function plainSpeechText(action: { text?: string; spokenText?: string }): string {
  const raw = action.text ?? '';
  const source = action.spokenText?.trim() || (raw.includes('[[') ? speechForTts(action) : raw);
  return stripInlineLatexForPlainTts(source);
}
