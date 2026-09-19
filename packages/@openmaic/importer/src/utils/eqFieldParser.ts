/**
 * Word EQ field code → LaTeX converter.
 *
 * EQ fields are the legacy math format used before OMML (Office 2003 and earlier).
 * Common in educational PPTs where formulas were authored in Word and pasted as OLE.
 *
 * Supported constructs:
 *   \f(num,den)                         → \frac{num}{den}
 *   \o(base,\s\up N(overlay))           → \overrightarrow{base} (when overlay is →)
 *   \b\lc X\rc Y(content)               → \left X content \right Y
 *   \a\vs N\al\co M(item1,item2,...)    → column array
 *   \s\up N(text)                        → ^{text}
 *   \s\do N(text)                        → _{text}
 *   \r(N,expr)                           → \sqrt[N]{expr} or \sqrt{expr}
 *   \i(,,expr,expr)                      → \int_{a}^{b}
 *
 * Reference: MS-OE376 §2.16.5.22 (EQ field) and Word field code documentation.
 */

/**
 * Convert a single EQ field instruction string to LaTeX.
 * Input should be the raw instrText content (e.g. "eq \\f(4,3)").
 */
export function eqFieldToLatex(instrText: string): string {
  let code = instrText.trim();
  if (/^eq\s+/i.test(code)) {
    code = code.replace(/^eq\s+/i, '');
  }
  try {
    return parseEqExpression(code, 0).latex;
  } catch {
    return code;
  }
}

interface ParseResult {
  latex: string;
  endPos: number;
}

function parseEqExpression(code: string, pos: number): ParseResult {
  const parts: string[] = [];

  while (pos < code.length) {
    const ch = code[pos];

    if (ch === ')') break;

    if (ch === '\\') {
      const result = parseCommand(code, pos);
      parts.push(result.latex);
      pos = result.endPos;
      continue;
    }

    parts.push(ch);
    pos++;
  }

  return { latex: parts.join(''), endPos: pos };
}

function parseCommand(code: string, pos: number): ParseResult {
  // pos is at '\'
  pos++;
  if (pos >= code.length) return { latex: '\\', endPos: pos };

  const cmdStart = pos;
  while (pos < code.length && /[a-zA-Z]/.test(code[pos])) pos++;
  const cmd = code.substring(cmdStart, pos);

  switch (cmd) {
    case 'f':
      return parseFraction(code, pos);
    case 'o':
      return parseOverlay(code, pos);
    case 'b':
      return parseBracket(code, pos);
    case 'a':
      return parseArray(code, pos);
    case 's':
      return parseShift(code, pos);
    case 'r':
      return parseRadical(code, pos);
    case 'i':
      return parseIntegral(code, pos);
    case 'lc':
      return parseLcRcModifier(code, pos, 'lc');
    case 'rc':
      return parseLcRcModifier(code, pos, 'rc');
    default:
      return { latex: '\\' + cmd, endPos: pos };
  }
}

/** \f(numerator,denominator) → \frac{num}{den} */
function parseFraction(code: string, pos: number): ParseResult {
  const args = readParenArgs(code, pos);
  if (!args) return { latex: '\\frac{}{}', endPos: pos };
  const num = args.items[0] ?? '';
  const den = args.items[1] ?? '';
  return {
    latex: `\\frac{${convertArg(num)}}{${convertArg(den)}}`,
    endPos: args.endPos,
  };
}

/** \o(base, \s\up N(overlay)) → overrightarrow etc. */
function parseOverlay(code: string, pos: number): ParseResult {
  const args = readParenArgs(code, pos);
  if (!args) return { latex: '', endPos: pos };
  const base = args.items[0] ?? '';
  const overlay = args.items.slice(1).join(',');

  if (overlay.includes('→') || overlay.includes('\\s\\up')) {
    return { latex: `\\overrightarrow{${convertArg(base)}}`, endPos: args.endPos };
  }
  if (overlay.includes('̲') || overlay.includes('_')) {
    return { latex: `\\underline{${convertArg(base)}}`, endPos: args.endPos };
  }
  return { latex: `\\overrightarrow{${convertArg(base)}}`, endPos: args.endPos };
}

/**
 * \b\lc X\rc Y(content) → \left X content \right Y
 * \b may also appear without \lc/\rc for simple brackets.
 */
function parseBracket(code: string, pos: number): ParseResult {
  let leftChar = '(';
  let rightChar = ')';

  while (pos < code.length && code[pos] === '\\') {
    const modResult = parseBracketModifier(code, pos);
    if (modResult.type === 'lc') {
      leftChar = modResult.char;
      pos = modResult.endPos;
    } else if (modResult.type === 'rc') {
      rightChar = modResult.char;
      pos = modResult.endPos;
    } else {
      break;
    }
  }

  const args = readParenArgs(code, pos);
  if (!args) return { latex: `\\left${leftChar}\\right${rightChar}`, endPos: pos };

  const inner = args.items.map(convertArg).join(', ');
  return {
    latex: `\\left${leftChar}${inner}\\right${rightChar}`,
    endPos: args.endPos,
  };
}

function parseBracketModifier(
  code: string,
  pos: number,
): { type: string; char: string; endPos: number } {
  if (code.substring(pos, pos + 3) === '\\lc') {
    pos += 3;
    const ch = readBracketChar(code, pos);
    return { type: 'lc', char: ch.char, endPos: ch.endPos };
  }
  if (code.substring(pos, pos + 3) === '\\rc') {
    pos += 3;
    const ch = readBracketChar(code, pos);
    return { type: 'rc', char: ch.char, endPos: ch.endPos };
  }
  return { type: 'unknown', char: '', endPos: pos };
}

function readBracketChar(code: string, pos: number): { char: string; endPos: number } {
  if (pos >= code.length) return { char: '.', endPos: pos };
  if (code[pos] === '\\' && pos + 1 < code.length) {
    // Escaped char like \( \) \{ \} \| \[  \]
    return { char: code[pos + 1], endPos: pos + 2 };
  }
  return { char: code[pos], endPos: pos + 1 };
}

/** \a\vs N\al\co M(items) → \begin{array}{c} items \end{array} */
function parseArray(code: string, pos: number): ParseResult {
  let cols = 1;
  // Parse modifiers: \vs N, \al, \co M, etc.
  while (pos < code.length && code[pos] === '\\') {
    const sub = code.substring(pos);
    const coMatch = sub.match(/^\\co(\d+)/);
    if (coMatch) {
      cols = parseInt(coMatch[1], 10) || 1;
      pos += coMatch[0].length;
      continue;
    }
    const modMatch = sub.match(/^\\[a-zA-Z]+\d*/);
    if (modMatch) {
      pos += modMatch[0].length;
      continue;
    }
    break;
  }

  const args = readParenArgs(code, pos);
  if (!args) return { latex: '', endPos: pos };

  const colSpec = 'c'.repeat(cols);
  const items = args.items.map(convertArg);

  if (cols === 1) {
    return {
      latex: `\\begin{array}{${colSpec}}${items.join('\\\\')}\\end{array}`,
      endPos: args.endPos,
    };
  }

  // Multi-column: chunk items into rows
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += cols) {
    rows.push(items.slice(i, i + cols).join(' & '));
  }
  return {
    latex: `\\begin{array}{${colSpec}}${rows.join('\\\\')}\\end{array}`,
    endPos: args.endPos,
  };
}

/** \s\up N(text) → ^{text}   or   \s\do N(text) → _{text} */
function parseShift(code: string, pos: number): ParseResult {
  // Skip \s and read direction
  let dir = 'up';
  if (code.substring(pos, pos + 3) === '\\up') {
    dir = 'up';
    pos += 3;
  } else if (code.substring(pos, pos + 3) === '\\do') {
    dir = 'down';
    pos += 3;
  }
  // Skip numeric argument (shift amount in half-points)
  while (pos < code.length && /\d/.test(code[pos])) pos++;

  const args = readParenArgs(code, pos);
  if (!args) return { latex: '', endPos: pos };
  const content = convertArg(args.items[0] ?? '');

  if (dir === 'up') return { latex: `^{${content}}`, endPos: args.endPos };
  return { latex: `_{${content}}`, endPos: args.endPos };
}

/** \r(degree, radicand) or \r(,radicand) → \sqrt[degree]{radicand} */
function parseRadical(code: string, pos: number): ParseResult {
  const args = readParenArgs(code, pos);
  if (!args) return { latex: '\\sqrt{}', endPos: pos };
  if (args.items.length >= 2 && args.items[0].trim()) {
    return {
      latex: `\\sqrt[${convertArg(args.items[0])}]{${convertArg(args.items[1])}}`,
      endPos: args.endPos,
    };
  }
  const radicand = args.items[args.items.length - 1] ?? '';
  return { latex: `\\sqrt{${convertArg(radicand)}}`, endPos: args.endPos };
}

/** \i(type,sub,sup,integrand) → \int_{sub}^{sup} integrand */
function parseIntegral(code: string, pos: number): ParseResult {
  const args = readParenArgs(code, pos);
  if (!args) return { latex: '\\int', endPos: pos };
  const sub = args.items[2] ? `_{${convertArg(args.items[2])}}` : '';
  const sup = args.items[3] ? `^{${convertArg(args.items[3])}}` : '';
  return { latex: `\\int${sub}${sup}`, endPos: args.endPos };
}

/** Handle standalone \lc or \rc encountered outside \b (shouldn't happen, but be robust). */
function parseLcRcModifier(code: string, pos: number, _type: string): ParseResult {
  const ch = readBracketChar(code, pos);
  return { latex: ch.char, endPos: ch.endPos };
}

/**
 * Read a parenthesized argument list: (arg1,arg2,...).
 * Handles nested parentheses and EQ sub-commands.
 * Uses full-width comma (，) as separator in addition to ASCII comma.
 */
function readParenArgs(code: string, pos: number): { items: string[]; endPos: number } | null {
  // Skip whitespace
  while (pos < code.length && code[pos] === ' ') pos++;
  if (pos >= code.length || code[pos] !== '(') return null;
  pos++; // skip '('

  const items: string[] = [];
  let current = '';
  let depth = 0;

  while (pos < code.length) {
    const ch = code[pos];

    if (ch === '(') {
      depth++;
      current += ch;
      pos++;
    } else if (ch === ')') {
      if (depth === 0) {
        items.push(current);
        pos++; // skip ')'
        return { items, endPos: pos };
      }
      depth--;
      current += ch;
      pos++;
    } else if ((ch === ',' || ch === '，') && depth === 0) {
      items.push(current);
      current = '';
      pos++;
    } else {
      current += ch;
      pos++;
    }
  }

  // Unterminated — return what we have
  items.push(current);
  return { items, endPos: pos };
}

/** Recursively convert a sub-expression that may itself contain EQ commands. */
function convertArg(arg: string): string {
  const trimmed = arg.trim();
  if (!trimmed) return '';
  if (trimmed.includes('\\')) {
    try {
      return parseEqExpression(trimmed, 0).latex;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Word document.xml → text + EQ fields extraction
// ---------------------------------------------------------------------------

export interface DocxMathContent {
  /** LaTeX representation of the full line (text + formulas). */
  latex: string;
  /** Plain text representation (formulas simplified to readable text). */
  plainText: string;
}

/**
 * Parse word/document.xml content and extract text + EQ fields,
 * converting the full paragraph content into LaTeX and plain text.
 *
 * Structure: <w:body><w:p>...<w:r>(w:t | w:fldChar+w:instrText)...</w:r>...</w:p></w:body>
 *
 * @param xmlString raw XML content of word/document.xml
 */
export function parseDocxMathContent(xmlString: string): DocxMathContent {
  const latexParts: string[] = [];
  const textParts: string[] = [];

  // Extract all w:r runs in order
  const runs = extractRuns(xmlString);

  let inField = false;
  let fieldCode = '';

  for (const run of runs) {
    if (run.type === 'fldChar') {
      if (run.fldCharType === 'begin') {
        inField = true;
        fieldCode = '';
      } else if (run.fldCharType === 'separate') {
        // Display text follows; we ignore it and use our own conversion
      } else if (run.fldCharType === 'end') {
        if (fieldCode.trim()) {
          const latex = eqFieldToLatex(fieldCode);
          latexParts.push(latex);
          textParts.push(eqFieldToPlainText(fieldCode));
        }
        inField = false;
        fieldCode = '';
      }
    } else if (run.type === 'instrText') {
      fieldCode += run.text;
    } else if (run.type === 'text') {
      if (!inField) {
        if (run.isItalic) {
          latexParts.push(`\\textit{${run.text}}`);
        } else {
          latexParts.push(`\\text{${run.text}}`);
        }
        textParts.push(run.text);
      }
    }
  }

  return {
    latex: latexParts
      .join('')
      .replace(/\\text\{}\s*/g, '')
      .trim(),
    plainText: textParts.join('').trim(),
  };
}

interface DocxRun {
  type: 'text' | 'instrText' | 'fldChar';
  text: string;
  isItalic?: boolean;
  fldCharType?: string;
}

/** Simple XML regex extraction — avoids needing a full DOM parser. */
function extractRuns(xml: string): DocxRun[] {
  const runs: DocxRun[] = [];

  // Match each <w:r ...>...</w:r> block
  const runRegex = /<w:r[\s>][\s\S]*?<\/w:r>/g;
  let match: RegExpExecArray | null;

  while ((match = runRegex.exec(xml)) !== null) {
    const runXml = match[0];

    // Check for italic
    const isItalic = /<w:i\s*\/>/.test(runXml) || /<w:i\b/.test(runXml);

    // fldChar
    const fldCharMatch = runXml.match(/w:fldCharType="(\w+)"/);
    if (fldCharMatch) {
      runs.push({ type: 'fldChar', text: '', fldCharType: fldCharMatch[1] });
      continue;
    }

    // instrText
    const instrMatch = runXml.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/);
    if (instrMatch) {
      runs.push({ type: 'instrText', text: instrMatch[1] });
      continue;
    }

    // Regular text
    const textMatch = runXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
    if (textMatch) {
      runs.push({ type: 'text', text: textMatch[1], isItalic });
    }
  }

  return runs;
}

/**
 * Simplified plain-text version of an EQ field.
 * Re-uses the parser but maps to readable text instead of LaTeX.
 */
function eqFieldToPlainText(instrText: string): string {
  let code = instrText.trim();
  if (/^eq\s+/i.test(code)) code = code.replace(/^eq\s+/i, '');
  try {
    return eqToPlain(code, 0).text;
  } catch {
    return code
      .replace(/\\[a-zA-Z]+\d*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

function eqToPlain(code: string, pos: number): { text: string; endPos: number } {
  const parts: string[] = [];
  while (pos < code.length) {
    const ch = code[pos];
    if (ch === ')') break;
    if (ch === '\\') {
      const cmdStart = pos + 1;
      let p = cmdStart;
      while (p < code.length && /[a-zA-Z]/.test(code[p])) p++;
      const cmd = code.substring(cmdStart, p);
      if (cmd === 'f') {
        const args = readParenArgs(code, p);
        if (args) {
          parts.push(`${plainArg(args.items[0])}/${plainArg(args.items[1])}`);
          pos = args.endPos;
        } else {
          pos = p;
        }
      } else if (cmd === 'o') {
        const args = readParenArgs(code, p);
        if (args) {
          parts.push(plainArg(args.items[0]) + '→');
          pos = args.endPos;
        } else {
          pos = p;
        }
      } else if (cmd === 'b') {
        while (p < code.length && code[p] === '\\') {
          const mod = code.substring(p).match(/^\\[a-zA-Z]+\\?./);
          if (mod) p += mod[0].length;
          else break;
        }
        const args = readParenArgs(code, p);
        if (args) {
          parts.push('(' + args.items.map(plainArg).join(', ') + ')');
          pos = args.endPos;
        } else {
          pos = p;
        }
      } else if (cmd === 'a') {
        while (p < code.length && code[p] === '\\') {
          const mod = code.substring(p).match(/^\\[a-zA-Z]+\d*/);
          if (mod) p += mod[0].length;
          else break;
        }
        const args = readParenArgs(code, p);
        if (args) {
          parts.push(args.items.map(plainArg).join(', '));
          pos = args.endPos;
        } else {
          pos = p;
        }
      } else if (cmd === 's') {
        // skip \up N or \do N
        if (code.substring(p, p + 3) === '\\up' || code.substring(p, p + 3) === '\\do') p += 3;
        while (p < code.length && /\d/.test(code[p])) p++;
        const args = readParenArgs(code, p);
        if (args) {
          parts.push(plainArg(args.items[0]));
          pos = args.endPos;
        } else {
          pos = p;
        }
      } else if (cmd === 'r') {
        const args = readParenArgs(code, p);
        if (args) {
          parts.push('√(' + args.items.map(plainArg).join(',') + ')');
          pos = args.endPos;
        } else {
          pos = p;
        }
      } else {
        // Unknown command — skip
        pos = p;
      }
      continue;
    }
    parts.push(ch === '，' ? ', ' : ch);
    pos++;
  }
  return { text: parts.join(''), endPos: pos };
}

function plainArg(s: string | undefined): string {
  if (!s) return '';
  const t = s.trim();
  if (t.includes('\\')) {
    try {
      return eqToPlain(t, 0).text;
    } catch {
      /* fall through */
    }
  }
  return t;
}
