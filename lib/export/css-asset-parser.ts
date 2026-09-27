import postcss, { type AtRule, type Root } from 'postcss';
import valueParser, { type Node as CssValueNode } from 'postcss-value-parser';

export interface CssUrlReference {
  raw: string;
  start: number;
  end: number;
}

/** CSS drops an escaped newline from a token value: url("a\<LF>b") is "ab". */
const ESCAPED_NEWLINE_RE = /\\\r\n|\\\n|\\\r|\\\f/;
/**
 * Escape-aware removal of escaped newlines from a quoted-string value: `\` +
 * newline (LF / CRLF / CR / FF) is dropped; other escapes are kept verbatim so
 * `\\` + newline leaves a raw newline behind (a bad-string token) for the
 * caller to reject.
 */
function stripEscapedNewlines(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) break;
    if (next === '\n' || next === '\r' || next === '\f') {
      i += next === '\r' && value[i + 2] === '\n' ? 2 : 1;
      continue;
    }
    out += c + next;
    i++;
  }
  return out;
}

type CssStringEnd = { kind: 'quote' | 'newline' | 'eof'; end: number };

/**
 * Scan a CSS quoted string starting after its opening quote. Per CSS Syntax
 * §4.3.5, an unescaped \n/\r/\f yields a bad-string token (browsers recover at
 * that character), while EOF yields a valid string token that browsers keep;
 * a backslash at EOF is consumed.
 */
function scanCssString(css: string, start: number, quote: string): CssStringEnd {
  const n = css.length;
  let j = start;
  while (j < n) {
    if (css[j] === '\\') {
      // An escaped newline continues the string (\r\n counts as one).
      if (j + 1 >= n) return { kind: 'eof', end: j };
      j += css[j + 1] === '\r' && css[j + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (css[j] === quote) return { kind: 'quote', end: j };
    if (css[j] === '\n' || css[j] === '\r' || css[j] === '\f') return { kind: 'newline', end: j };
    j++;
  }
  return { kind: 'eof', end: n };
}

export function cssUrlReferences(value: string): CssUrlReference[] {
  const refs: CssUrlReference[] = [];
  valueParser(value).walk((node: CssValueNode) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const inner = node.nodes?.[0];
    if (inner && inner.type === 'string') {
      // Non-whitespace (comments are fine) after the closing quote makes a
      // bad-url token.
      if (node.nodes.slice(1).some((part) => part.type !== 'space' && part.type !== 'comment'))
        return false;
      // Quoted url() (including an EOF-truncated one, which CSS treats as a
      // valid string token — stringify() would drop the closing quote).
      let content = (inner as { unclosed?: boolean; value: string }).value;
      if ((inner as { unclosed?: boolean }).unclosed && content.endsWith('\\'))
        content = content.slice(0, -1);
      content = stripEscapedNewlines(content);
      // A raw (unescaped) newline inside the string is a bad-string token;
      // browsers drop it, so it is no dependency — same as the fallback scanner.
      if (/[\n\r\f]/.test(content)) return false;
      refs.push({ raw: content, start: node.sourceIndex, end: node.sourceEndIndex });
      return false;
    }
    const raw = valueParser.stringify(node.nodes).trim();
    if (!raw) return false;
    // In an unquoted url() a backslash newline is a bad-url token instead,
    // and a bad url is not a dependency: browsers drop the declaration.
    if (ESCAPED_NEWLINE_RE.test(raw)) return false;
    refs.push({ raw, start: node.sourceIndex, end: node.sourceEndIndex });
    return false;
  });
  return refs;
}

export function rewriteCssValue(
  value: string,
  replacementFor: (raw: string) => string | undefined,
): string {
  return cssUrlReferences(value)
    .sort((left, right) => right.start - left.start)
    .reduce((rewritten, ref) => {
      const replacement = replacementFor(ref.raw);
      return replacement === undefined
        ? rewritten
        : rewritten.slice(0, ref.start) + `url(${replacement})` + rewritten.slice(ref.end);
    }, value);
}

export function cssImportReference(rule: AtRule): { url: string; conditions: string } | null {
  const parsed = valueParser(rule.params);
  const node = parsed.nodes.find(
    (candidate) => candidate.type !== 'space' && candidate.type !== 'comment',
  );
  if (!node) return null;
  let url: string | null = null;
  let quoted = false;
  let unclosed = false;
  if (node.type === 'string') {
    url = (node as { unclosed?: boolean; value: string }).value;
    quoted = true;
    unclosed = (node as { unclosed?: boolean }).unclosed === true;
  }
  if (node.type === 'function' && node.value.toLowerCase() === 'url') {
    const inner = (node.nodes ?? [])[0];
    if (inner && inner.type === 'string') {
      // Non-whitespace (comments are fine) after the closing quote makes a
      // bad-url token.
      if (
        (node.nodes ?? []).slice(1).some((part) => part.type !== 'space' && part.type !== 'comment')
      )
        return null;
      url = (inner as { unclosed?: boolean; value: string }).value;
      quoted = true;
      unclosed = (inner as { unclosed?: boolean }).unclosed === true;
    } else {
      const raw = valueParser.stringify(node.nodes).trim();
      if (!raw || ESCAPED_NEWLINE_RE.test(raw)) return null;
      url = raw;
    }
  }
  if (!url) return null;
  if (quoted) {
    if (unclosed && url.endsWith('\\')) url = url.slice(0, -1);
    url = stripEscapedNewlines(url);
    // A raw newline inside a quoted string is a bad-string token.
    if (/[\n\r\f]/.test(url)) return null;
  }
  return { url, conditions: rule.params.slice(node.sourceEndIndex).trim() };
}

export function parseCss(css: string, cssUrl: string): Root {
  try {
    return postcss.parse(css, { from: undefined });
  } catch (error) {
    throw new Error(
      `interactive-css-parse-failed:${cssUrl}:${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Best-effort fallback for `collectCssAssetReferences` when strict parsing
 * fails. A tiny token scanner (not a regex pile) that is comment- and
 * string-aware, so textual `content: "url(...)"`, commented-out imports and
 * lookalike function names (`myurl(`) are not mistaken for dependencies, while
 * real remote refs in malformed CSS stay visible to residual validation (e.g.
 * the video export's offline-completeness check).
 */
export function collectCssAssetReferencesByRegex(
  css: string,
): Array<{ kind: 'css-url' | 'css-import'; url: string }> {
  const refs: Array<{ kind: 'css-url' | 'css-import'; url: string }> = [];
  const n = css.length;
  let i = 0;
  let importNext = false;
  const isWordChar = (c: string) => /[\w-]/.test(c);
  while (i < n) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      // Unterminated comments run to end-of-stylesheet, like browsers.
      // Comments count as whitespace: `@import /* c */ "x.css"` stays intact.
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const scan = scanCssString(css, i + 1, ch);
      // EOF yields a valid string token (browsers keep the value); only an
      // unescaped newline is a bad string whose value must not be taken.
      if (scan.kind !== 'newline' && importNext)
        refs.push({ kind: 'css-import', url: stripEscapedNewlines(css.slice(i + 1, scan.end)) });
      importNext = false;
      i = scan.kind === 'quote' ? scan.end + 1 : scan.end;
      continue;
    }
    if (ch === '@') {
      i++;
      continue;
    }
    if (!isWordChar(ch)) {
      if (!/\s/.test(ch)) importNext = false;
      i++;
      continue;
    }
    let j = i;
    while (j < n && isWordChar(css[j])) j++;
    const word = css.slice(i, j).toLowerCase();
    if (word === 'import') {
      importNext = true;
      i = j;
      continue;
    }
    if (word === 'url' && css[j] === '(') {
      let k = j + 1;
      // Whitespace and comments may precede the url payload.
      for (;;) {
        if (css[k] === '/' && css[k + 1] === '*') {
          const endc = css.indexOf('*/', k + 2);
          k = endc === -1 ? n : endc + 2;
          continue;
        }
        if (/\s/.test(css[k] ?? '')) {
          k++;
          continue;
        }
        break;
      }
      const quote = css[k] === '"' || css[k] === "'" ? css[k] : null;
      if (quote) {
        const scan = scanCssString(css, k + 1, quote);
        // Non-whitespace between the closing quote and ')' is a bad-url token.
        let after = scan.kind === 'quote' ? scan.end + 1 : scan.end;
        // Whitespace and comments may sit between the closing quote and ')'.
        for (;;) {
          const cch = css[after];
          if (cch === '/' && css[after + 1] === '*') {
            const endc = css.indexOf('*/', after + 2);
            after = endc === -1 ? n : endc + 2;
            continue;
          }
          if (/\s/.test(cch ?? '')) {
            after++;
            continue;
          }
          break;
        }
        // EOF auto-closes the function; a newline is a bad string; otherwise
        // only whitespace may sit between the closing quote and ')'.
        const closedCleanly =
          scan.kind === 'eof' || (scan.kind === 'quote' && (after >= n || css[after] === ')'));
        if (closedCleanly) {
          refs.push({
            kind: importNext ? 'css-import' : 'css-url',
            url: stripEscapedNewlines(css.slice(k + 1, scan.end)),
          });
        }
        // A bad url consumes everything up to its ')' like the browser does,
        // so nested url(...) text inside it is not re-scanned.
        let close = scan.kind === 'quote' ? scan.end + 1 : scan.end;
        while (close < n && css[close] !== ')') close++;
        i = close + 1;
      } else {
        let m = k;
        while (m < n) {
          if (css[m] === '\\') {
            m += 2;
            continue;
          }
          if (css[m] === ')') break;
          m++;
        }
        // In an unquoted url() a backslash newline is a bad-url token
        // (§4.3.6): browsers drop the declaration, so it is no dependency.
        const raw = css.slice(k, m).trim();
        if (raw && !ESCAPED_NEWLINE_RE.test(raw))
          refs.push({ kind: importNext ? 'css-import' : 'css-url', url: raw });
        i = m + 1;
      }
      importNext = false;
      continue;
    }
    importNext = false;
    i = j;
  }
  return refs;
}

export function collectCssAssetReferences(
  css: string,
  context: 'stylesheet' | 'declaration-list' = 'stylesheet',
): Array<{ kind: 'css-url' | 'css-import'; url: string }> {
  // Authored CSS (e.g. LLM-generated interactive scenes) can carry browser-
  // tolerated syntax errors like `-- name: value`. Strict parsing here would
  // abort the whole export, so collection is best-effort instead.
  let root: Root;
  try {
    root = parseCss(context === 'stylesheet' ? css : `.x{${css}}`, 'inline-css');
  } catch {
    return collectCssAssetReferencesByRegex(css);
  }
  const refs: Array<{ kind: 'css-url' | 'css-import'; url: string }> = [];
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() !== 'import') return;
    const reference = cssImportReference(rule);
    if (reference) refs.push({ kind: 'css-import', url: reference.url });
  });
  root.walkDecls((declaration) => {
    for (const ref of cssUrlReferences(declaration.value)) {
      refs.push({ kind: 'css-url', url: ref.raw });
    }
  });
  return refs;
}
