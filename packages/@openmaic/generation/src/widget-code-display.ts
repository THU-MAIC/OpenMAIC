import { Buffer } from 'node:buffer';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_NODES = 100_000;
const INLINE_TAGS = new Set([
  'span',
  'mark',
  'b',
  'strong',
  'i',
  'em',
  's',
  'u',
  'small',
  'sub',
  'sup',
]);
const INACTIVE_TAGS = new Set(['head', 'script', 'style', 'template', 'noscript']);
type Role = 'original' | 'reference';
export type WidgetCodeDisplayCheck =
  | { ok: true }
  | {
      ok: false;
      kind:
        | 'limit'
        | 'missing-source'
        | 'missing-display'
        | 'ambiguous-display'
        | 'invalid-display'
        | 'source-mismatch';
      role?: Role;
    };

function attr(node: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return node.attrs.find((entry) => entry.name === name)?.value;
}
function hidden(node: DefaultTreeAdapterTypes.Element): boolean {
  return (
    attr(node, 'hidden') !== undefined ||
    attr(node, 'aria-hidden')?.toLowerCase() === 'true' ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test(
      attr(node, 'style') || '',
    )
  );
}
function text(node: DefaultTreeAdapterTypes.Node): string | null {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
  if (node.nodeName === '#comment') return '';
  if (!('tagName' in node) || node.namespaceURI !== HTML_NAMESPACE || hidden(node)) return null;
  if (node.tagName === 'br') return '\n';
  if (node.tagName !== 'code' && !INLINE_TAGS.has(node.tagName)) return null;
  let result = '';
  for (const child of node.childNodes) {
    const part = text(child);
    if (part === null) return null;
    result += part;
  }
  return result;
}
const lines = (value: string) => value.replace(/\r\n?/g, '\n');

/** Static display completeness only; does not execute HTML or prove CSS visibility/math. */
export function checkWidgetCodeDisplay(
  html: string,
  source: { code: string; correctedCode?: string } | undefined,
): WidgetCodeDisplayCheck {
  if (!source || typeof source.code !== 'string' || !source.code.length)
    return { ok: false, kind: 'missing-source' };
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) return { ok: false, kind: 'limit' };
  const duplicates: number[] = [];
  const document = parse(html, {
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
    onParseError(error) {
      if (error.code === 'duplicate-attribute') duplicates.push(error.startOffset);
    },
  });
  const displays: Record<Role, DefaultTreeAdapterTypes.Element[]> = { original: [], reference: [] };
  let count = 0;
  let invalid = false;
  function visit(node: DefaultTreeAdapterTypes.Node, inPre = false): void {
    if (++count > MAX_NODES) return;
    if ('tagName' in node) {
      if (node.namespaceURI !== HTML_NAMESPACE || INACTIVE_TAGS.has(node.tagName) || hidden(node))
        return;
      const role = attr(node, 'data-codemate-source');
      if (role !== undefined) {
        if ((role !== 'original' && role !== 'reference') || node.tagName !== 'code' || !inPre)
          invalid = true;
        else {
          const tag = node.sourceCodeLocation?.startTag;
          if (
            tag &&
            duplicates.some((offset) => offset >= tag.startOffset && offset < tag.endOffset)
          )
            invalid = true;
          displays[role].push(node);
        }
      }
      inPre ||= node.tagName === 'pre';
    }
    if ('childNodes' in node) node.childNodes.forEach((child) => visit(child, inPre));
  }
  visit(document);
  if (count > MAX_NODES) return { ok: false, kind: 'limit' };
  if (invalid) return { ok: false, kind: 'invalid-display' };
  const hasReference =
    typeof source.correctedCode === 'string' && source.correctedCode.trim().length > 0;
  if (!hasReference && displays.reference.length)
    return { ok: false, kind: 'invalid-display', role: 'reference' };
  const roles: Role[] = hasReference ? ['original', 'reference'] : ['original'];
  for (const role of roles) {
    if (displays[role].length === 0) return { ok: false, kind: 'missing-display', role };
    if (displays[role].length !== 1) return { ok: false, kind: 'ambiguous-display', role };
    const displayed = text(displays[role][0]);
    if (displayed === null) return { ok: false, kind: 'invalid-display', role };
    const expected = role === 'original' ? source.code : source.correctedCode!;
    // HTML normalizes literal CR/CRLF. No trim, wrapper-LF removal, indentation or token normalization.
    if (lines(displayed) !== lines(expected)) return { ok: false, kind: 'source-mismatch', role };
  }
  return { ok: true };
}
