import postcss, { type AtRule, type Root } from 'postcss';
import valueParser, { type Node as CssValueNode } from 'postcss-value-parser';

export interface CssUrlReference {
  raw: string;
  start: number;
  end: number;
}

export function cssUrlReferences(value: string): CssUrlReference[] {
  const refs: CssUrlReference[] = [];
  valueParser(value).walk((node: CssValueNode) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const raw = valueParser.stringify(node.nodes).trim();
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    refs.push({ raw: unquoted, start: node.sourceIndex, end: node.sourceEndIndex });
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

export function collectCssAssetReferences(
  css: string,
  context: 'stylesheet' | 'declaration-list' = 'stylesheet',
): Array<{ kind: 'css-url' | 'css-import'; url: string }> {
  const root = parseCss(context === 'stylesheet' ? css : `.x{${css}}`, 'inline-css');
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
