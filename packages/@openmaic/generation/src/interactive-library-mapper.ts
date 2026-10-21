import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { parse as parseModules } from 'es-module-lexer/js';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import {
  INTERACTIVE_ASSET_PATH,
  INTERACTIVE_LIBRARIES,
  interactiveAssetBaseUrl,
  interactiveLibraryUrl,
} from './interactive-libraries.js';

/** Versions without a lower bound (unversioned/latest) intentionally select our pin. */
function compatible(requested: string, version: string, policy: string): boolean {
  if (!requested || requested === 'latest') return true;
  // Accept exact, partial, wildcard, caret and tilde forms only; reject arbitrary ranges/tags.
  const match = /^(?:\^|~)?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(requested);
  if (!match) return false;
  const hosted = version.split('.').map(Number);
  if (Number(match[1]) !== hosted[0]) return false;
  if (policy === 'minor' && match[2] !== String(hosted[1])) return false;
  // Never downgrade a concrete requested minimum to an older hosted version.
  const minimum = [Number(match[1]), Number(match[2]) || 0, Number(match[3]) || 0];
  for (let i = 0; i < 3; i++) {
    if (minimum[i] !== hosted[i]) return minimum[i]! < hosted[i]!;
  }
  return true;
}

export function mapInteractiveLibraryUrl(
  input: string,
  baseUrl = interactiveAssetBaseUrl(),
): string | undefined {
  const localBase = interactiveAssetBaseUrl().replace(/\/$/, '');
  if (input.startsWith(`${INTERACTIVE_ASSET_PATH}/`))
    return baseUrl.replace(/\/$/, '') + input.slice(INTERACTIVE_ASSET_PATH.length);
  if (localBase.startsWith('/') && input.startsWith(`${localBase}/`))
    return baseUrl.replace(/\/$/, '') + input.slice(localBase.length);
  let url: URL;
  try {
    url = new URL(input.startsWith('//') ? `https:${input}` : input);
  } catch {
    return undefined;
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
    return undefined;
  // Query parameters can change CDN output (e.g. ?module, ?plugins=). Never guess.
  if (url.search || url.hash) return undefined;
  let name: string;
  let version: string;
  let file: string;
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com') {
    const path =
      url.hostname === 'cdn.jsdelivr.net'
        ? /^\/npm\/(.+)$/.exec(url.pathname)?.[1]
        : url.pathname.slice(1);
    if (!path) return undefined;
    if (path.includes('%')) return undefined;
    const match = /^(@[^/]+\/[^/@]+|[^/@]+)(?:@([^/]+))?(?:\/(.*))?$/.exec(path);
    if (!match) return undefined;
    name = match[1]!;
    version = match[2] ?? '';
    file = match[3] ?? '';
  } else if (url.hostname === 'cdnjs.cloudflare.com') {
    const match = /^\/ajax\/libs\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) return undefined;
    const library = INTERACTIVE_LIBRARIES.find((entry) => entry.cdnjs === match[1]);
    if (!library) return undefined;
    name = library.package;
    version = match[2]!;
    file = match[3]!;
    if (name === 'katex' && !file.startsWith('dist/')) file = `dist/${file}`;
    if (name === 'three' && /^three(?:\.module)?(?:\.min)?\.js$/.test(file)) file = `build/${file}`;
  } else return undefined;
  const library = INTERACTIVE_LIBRARIES.find((entry) => entry.package === name);
  if (!library || !compatible(version, library.version, library.compatibility)) return undefined;
  if (!file) file = library.entry;
  const aliases: Readonly<Record<string, string>> = library.aliases;
  file = aliases[file] ?? file;
  if (file.includes('..') || file.includes('%') || file.includes('\\')) return undefined;
  const allowed = library.files.some(
    (entry) =>
      file === entry ||
      ((entry === 'build' || entry === 'examples/jsm' || entry === 'dist/fonts') &&
        file.startsWith(`${entry}/`) &&
        (file.endsWith('.js') || /\.(woff2?|ttf)$/.test(file) || file.endsWith('/'))),
  );
  if (!allowed) return undefined;
  return interactiveLibraryUrl(name, file, baseUrl);
}

type Node = DefaultTreeAdapterTypes.Node;
export function htmlNodes(html: string): Node[] {
  const nodes: Node[] = [];
  const pending: Node[] = [parse(html, { sourceCodeLocationInfo: true })];
  while (pending.length) {
    const node = pending.pop()!;
    nodes.push(node);
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        pending.push(node.childNodes[index]!);
    }
    if ('content' in node) pending.push(node.content);
  }
  return nodes;
}

export interface HtmlPatch {
  start: number;
  end: number;
  text: string;
}
export function patchHtml(html: string, patches: HtmlPatch[]): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const patch of patches.sort((a, b) => a.start - b.start)) {
    chunks.push(html.slice(cursor, patch.start), patch.text);
    cursor = patch.end;
  }
  chunks.push(html.slice(cursor));
  return chunks.join('');
}

export interface InteractiveLibraryMapping {
  html: string;
  /** Counts of unmatched resource references by host, for caller-side aggregation. */
  unmatchedExternalHosts: Record<string, number>;
}

/** Parser-based, source-preserving mapping. Unknown or invalid markup stays authored. */
export function rewriteInteractiveLibraries(
  html: string,
  baseUrl = interactiveAssetBaseUrl(),
): InteractiveLibraryMapping {
  const unmatchedExternalHosts: Record<string, number> = Object.create(null);
  const patches: HtmlPatch[] = [];
  const map = (value: string): string => {
    const mapped = mapInteractiveLibraryUrl(value, baseUrl);
    if (mapped) return mapped;
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value);
      const base = new URL(baseUrl, 'https://openmaic.invalid');
      if (
        ['https:', 'http:'].includes(url.protocol) &&
        !(
          url.origin === base.origin &&
          url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)
        )
      ) {
        unmatchedExternalHosts[url.hostname] = (unmatchedExternalHosts[url.hostname] ?? 0) + 1;
      }
    } catch {
      /* Relative and bare specifiers have no external host. */
    }
    return value;
  };
  for (const node of htmlNodes(html)) {
    if (!('tagName' in node)) continue;
    const attrName =
      node.tagName === 'script' ? 'src' : node.tagName === 'link' ? 'href' : undefined;
    const attr = node.attrs.find((entry) => entry.name === attrName);
    if (attr) {
      const mapped = map(attr.value);
      const location = node.sourceCodeLocation?.attrs?.[attr.name];
      if (mapped !== attr.value && location) {
        patches.push({
          start: location.startOffset,
          end: location.endOffset,
          text: `${attr.name}="${mapped.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`,
        });
        for (const name of ['integrity', 'crossorigin']) {
          const range = node.sourceCodeLocation?.attrs?.[name];
          if (range)
            patches.push({
              start: range.startOffset,
              end: range.endOffset,
              text: name === 'crossorigin' ? 'crossorigin="anonymous"' : '',
            });
        }
      }
    }
    const textNode = node.childNodes.find((child) => child.nodeName === '#text') as
      | DefaultTreeAdapterTypes.TextNode
      | undefined;
    const range = textNode?.sourceCodeLocation;
    if (!textNode || !range) continue;
    let rewritten = textNode.value;
    const type = node.attrs.find((entry) => entry.name === 'type')?.value;
    if (node.tagName === 'style') {
      try {
        const css = postcss.parse(rewritten);
        css.walkAtRules(/^import$/i, (rule) => {
          const params = valueParser(rule.params);
          const first = params.nodes.find(
            (entry) => entry.type !== 'space' && entry.type !== 'comment',
          );
          const value =
            first?.type === 'string'
              ? first
              : first?.type === 'function' && first.value.toLowerCase() === 'url'
                ? first.nodes.find((entry) => entry.type === 'string' || entry.type === 'word')
                : undefined;
          if (value && 'value' in value) value.value = map(value.value);
          rule.params = params.toString();
        });
        rewritten = css.toString();
      } catch {
        /* Leave malformed CSS untouched. */
      }
    } else if (node.tagName === 'script' && type === 'importmap') {
      try {
        const data = JSON.parse(rewritten);
        const rewriteEntries = (entries: unknown) => {
          if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;
          for (const [key, value] of Object.entries(entries)) {
            if (typeof value === 'string') (entries as Record<string, string>)[key] = map(value);
          }
        };
        rewriteEntries(data.imports);
        for (const entries of Object.values(data.scopes ?? {})) rewriteEntries(entries);
        const serialized = JSON.stringify(data).replace(/</g, '\\u003c');
        // Preserve bytes on the second pass and when nothing matched.
        if (JSON.stringify(JSON.parse(textNode.value)) !== JSON.stringify(data))
          rewritten = serialized;
      } catch {
        /* Leave malformed import maps untouched. */
      }
    } else if (node.tagName === 'script' && type === 'module') {
      try {
        const [imports] = parseModules(rewritten);
        const edits: HtmlPatch[] = [];
        for (const entry of imports) {
          if (!entry.n || entry.d === -2) continue;
          const mapped = map(entry.n);
          if (mapped === entry.n) continue;
          const quoted = entry.d >= 0;
          edits.push({
            start: entry.s,
            end: entry.e,
            text: quoted ? JSON.stringify(mapped) : mapped,
          });
        }
        rewritten = patchHtml(rewritten, edits);
      } catch {
        /* Leave invalid JavaScript untouched. */
      }
    }
    if (rewritten !== textNode.value)
      patches.push({ start: range.startOffset, end: range.endOffset, text: rewritten });
  }
  return { html: patchHtml(html, patches), unmatchedExternalHosts };
}
