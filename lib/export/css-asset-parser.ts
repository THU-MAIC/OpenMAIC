import postcss, { type AtRule, type Root } from 'postcss';
import valueParser, { type Node as CssValueNode } from 'postcss-value-parser';

export interface CssUrlReference {
  raw: string;
  start: number;
  end: number;
}

/** CSS drops an escaped newline from a token value: url("a\<LF>b") is "ab". */
const stripEscapedNewlines = (value: string) => value.replace(/\\\r\n|\\\n|\\\r|\\\f/g, '');

export function cssUrlReferences(value: string): CssUrlReference[] {
  const refs: CssUrlReference[] = [];
  valueParser(value).walk((node: CssValueNode) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const raw = valueParser.stringify(node.nodes).trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    refs.push({
      raw: stripEscapedNewlines(unquoted),
      start: node.sourceIndex,
      end: node.sourceEndIndex,
    });
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
  if (node.type === 'string') url = node.value;
  if (node.type === 'function' && node.value.toLowerCase() === 'url') {
    const raw = valueParser.stringify(node.nodes).trim();
    url =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
  }
  if (!url) return null;
  return {
    url: stripEscapedNewlines(url),
    conditions: rule.params.slice(node.sourceEndIndex).trim(),
  };
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
      // An unescaped \n/\r/\f ends the string as a bad-string token and the
      // browser recovers right there; scanning must too, or everything after
      // an unterminated string is swallowed and browser-active assets hidden.
      let j = i + 1;
      let terminated = false;
      while (j < n) {
        if (css[j] === '\\') {
          // An escaped newline continues the string; \r\n is one newline.
          j += css[j + 1] === '\r' && css[j + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (css[j] === ch) {
          terminated = true;
          break;
        }
        if (css[j] === '\n' || css[j] === '\r' || css[j] === '\f') break;
        j++;
      }
      if (terminated && importNext)
        refs.push({ kind: 'css-import', url: stripEscapedNewlines(css.slice(i + 1, j)) });
      importNext = false;
      i = terminated ? j + 1 : j;
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
      while (k < n && /\s/.test(css[k])) k++;
      const quote = css[k] === '"' || css[k] === "'" ? css[k] : null;
      if (quote) {
        let m = k + 1;
        let terminated = false;
        while (m < n) {
          if (css[m] === '\\') {
            m += css[m + 1] === '\r' && css[m + 2] === '\n' ? 3 : 2;
            continue;
          }
          if (css[m] === quote) {
            terminated = true;
            break;
          }
          if (css[m] === '\n' || css[m] === '\r' || css[m] === '\f') break;
          m++;
        }
        // An unterminated url("... string is a bad-string token: no URL is
        // taken from it and scanning resumes at the offending character.
        if (terminated) {
          refs.push({
            kind: importNext ? 'css-import' : 'css-url',
            url: stripEscapedNewlines(css.slice(k + 1, m)),
          });
        }
        i = terminated ? m + 1 : m;
      } else {
        let m = k;
        while (m < n && css[m] !== ')') m++;
        const raw = stripEscapedNewlines(css.slice(k, m).trim());
        if (raw) refs.push({ kind: importNext ? 'css-import' : 'css-url', url: raw });
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
