import { Buffer } from 'node:buffer';
import { parse as parseJavaScript } from 'acorn';
import { analyze } from 'eslint-scope';
import globals from 'globals';
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_ACTIVE_SCRIPTS = 64;
const MAX_AST_NODES = 100_000;
const JAVASCRIPT_MIME_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);
const BROWSER_NAMES = new Set([...Object.keys(globals.browser), ...Object.keys(globals.es2022)]);
const NAMED_HTML_ELEMENTS = new Set(['embed', 'form', 'img', 'object']);
const ASCII_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

type ScriptMode = 'script' | 'module';
type FailureKind =
  | 'syntax'
  | 'unbound-read'
  | 'unresolvable-write'
  | 'implicit-global-write-unsupported'
  | 'unsupported'
  | 'limit'
  | 'analysis-failed';

export type WidgetIdentifierCheck =
  | { ok: true; classicScripts: number; moduleScripts: number }
  | {
      ok: false;
      kind: FailureKind;
      scriptIndex: number;
      line?: number;
      column?: number;
    };

interface AstNode {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
}
interface ScriptSource {
  mode: ScriptMode;
  source: string;
  index: number;
  offset: number;
}
interface ParsedScript extends ScriptSource {
  parents: Map<number, AstNode>;
  scope: ReturnType<typeof analyze>;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'start' in value &&
    typeof value.start === 'number'
  );
}

function attribute(node: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return node.attrs.find((entry) => entry.name === name)?.value;
}

function scriptMode(node: DefaultTreeAdapterTypes.Element): ScriptMode | 'data' | 'unsupported' {
  const type = attribute(node, 'type');
  const language = attribute(node, 'language');
  const value = (
    type === '' || (type === undefined && !language)
      ? 'text/javascript'
      : type === undefined
        ? `text/${language}`
        : type
  ).toLowerCase();
  // MIME essence matching is exact: parameters never turn a data block into code.
  // Only an explicit type attribute gets the classic-MIME ASCII-trim fallback.
  if (
    JAVASCRIPT_MIME_TYPES.has(value) ||
    (type !== undefined &&
      JAVASCRIPT_MIME_TYPES.has(type.replace(ASCII_WHITESPACE, '').toLowerCase()))
  )
    return 'script';
  if (value === 'module') return 'module';
  if (value === 'importmap' || value === 'speculationrules') return 'unsupported';
  return 'data';
}

function dynamicCode(node: AstNode): boolean {
  if (node.type === 'WithStatement' || node.type === 'ImportExpression') return true;
  if (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration') &&
    node.source
  )
    return true;
  if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return false;
  const callee = node.callee;
  if (!isNode(callee)) return false;
  let name: unknown;
  if (callee.type === 'Identifier') name = callee.name;
  if (callee.type === 'MemberExpression' && isNode(callee.object) && isNode(callee.property)) {
    const owner = callee.object;
    if (owner.type === 'Identifier' && (owner.name === 'window' || owner.name === 'globalThis')) {
      name = callee.computed ? callee.property.value : callee.property.name;
    }
  }
  if (name === 'eval' || name === 'Function') return true;
  if (name !== 'setTimeout' && name !== 'setInterval') return false;
  const argument = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
  return (
    isNode(argument) &&
    ((argument.type === 'Literal' && typeof argument.value === 'string') ||
      argument.type === 'TemplateLiteral')
  );
}

/** A names-only check: never executes scripts, resolves imports or rewrites HTML. */
export function checkWidgetIdentifiers(html: string): WidgetIdentifierCheck {
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES)
    return { ok: false, kind: 'limit', scriptIndex: 0 };

  let currentScript = 0;
  try {
    const document = parseHtml(html, { scriptingEnabled: true, sourceCodeLocationInfo: true });
    const names = new Set(BROWSER_NAMES);
    const scripts: ScriptSource[] = [];
    let activeScripts = 0;
    const pending: DefaultTreeAdapterTypes.Node[] = [document];
    while (pending.length) {
      const node = pending.pop()!;
      if ('tagName' in node) {
        // IDs are named Window properties regardless of the element namespace.
        const id = attribute(node, 'id');
        if (id) names.add(id);
        if (node.namespaceURI === HTML_NAMESPACE && NAMED_HTML_ELEMENTS.has(node.tagName)) {
          const name = attribute(node, 'name');
          if (name) names.add(name);
        }
        if (
          node.namespaceURI === HTML_NAMESPACE &&
          (node.tagName === 'template' || node.tagName === 'noscript')
        )
          continue;
        for (const entry of node.attrs) {
          // Conservative compatibility boundary: HTML handler scopes are unsupported.
          if (/^on[a-z]/.test(entry.name) && entry.value.trim())
            return { ok: false, kind: 'unsupported', scriptIndex: currentScript };
          const url = entry.value.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
          if (
            ['href', 'action', 'formaction', 'src'].includes(entry.name) &&
            /^javascript:/i.test(url)
          )
            return { ok: false, kind: 'unsupported', scriptIndex: currentScript };
        }
        if (
          (node.tagName === 'iframe' &&
            (attribute(node, 'src') !== undefined || attribute(node, 'srcdoc') !== undefined)) ||
          (['embed', 'object'].includes(node.tagName) &&
            (attribute(node, 'src') !== undefined || attribute(node, 'data') !== undefined))
        )
          return { ok: false, kind: 'unsupported', scriptIndex: currentScript };
        if (node.tagName === 'script') {
          currentScript += 1;
          if (node.namespaceURI !== HTML_NAMESPACE)
            return { ok: false, kind: 'unsupported', scriptIndex: currentScript };
          const mode = scriptMode(node);
          if (mode === 'data') continue;
          if (mode === 'unsupported')
            return { ok: false, kind: 'unsupported', scriptIndex: currentScript };
          // ES2022 browsers do not execute classic nomodule scripts.
          if (mode === 'script' && attribute(node, 'nomodule') !== undefined) continue;
          // Legacy event scripts have conditional execution and a different environment.
          if (
            mode === 'script' &&
            attribute(node, 'for') !== undefined &&
            attribute(node, 'event') !== undefined
          )
            return { ok: false, kind: 'unsupported', scriptIndex: currentScript };
          activeScripts += 1;
          if (activeScripts > MAX_ACTIVE_SCRIPTS)
            return { ok: false, kind: 'limit', scriptIndex: currentScript };
          if (attribute(node, 'src') !== undefined)
            return { ok: false, kind: 'unsupported', scriptIndex: currentScript };
          const location = node.sourceCodeLocation;
          if (!location?.startTag || !location.endTag)
            return { ok: false, kind: 'unsupported', scriptIndex: currentScript };
          scripts.push({
            mode,
            source: html.slice(location.startTag.endOffset, location.endTag.startOffset),
            offset: location.startTag.endOffset,
            index: currentScript,
          });
        }
      }
      if ('childNodes' in node) {
        for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
      }
    }

    const parsed: ParsedScript[] = [];
    let nodeCount = 0;
    for (const script of scripts) {
      currentScript = script.index;
      let ast: AstNode;
      try {
        ast = parseJavaScript(script.source, {
          ecmaVersion: 2022,
          sourceType: script.mode,
          ranges: true,
          locations: true,
        }) as unknown as AstNode;
      } catch (error) {
        return {
          ok: false,
          kind: error instanceof SyntaxError ? 'syntax' : 'analysis-failed',
          scriptIndex: script.index,
        };
      }
      const parents = new Map<number, AstNode>();
      const functions: AstNode[] = [];
      const nodes: Array<{ node: AstNode; parent?: AstNode }> = [{ node: ast }];
      while (nodes.length) {
        const { node, parent } = nodes.pop()!;
        nodeCount += 1;
        if (nodeCount > MAX_AST_NODES)
          return { ok: false, kind: 'limit', scriptIndex: script.index };
        if (parent) parents.set(node.start, parent);
        if (node.type === 'FunctionDeclaration') {
          functions.push(node);
          // Legacy unbraced conditional functions are outside this grammar contract.
          if (parent?.type === 'IfStatement' || parent?.type === 'LabeledStatement')
            return { ok: false, kind: 'unsupported', scriptIndex: script.index };
        }
        if (dynamicCode(node)) return { ok: false, kind: 'unsupported', scriptIndex: script.index };
        for (const value of Object.values(node)) {
          if (isNode(value)) nodes.push({ node: value, parent: node });
          else if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) nodes.push({ node: item, parent: node });
          }
        }
      }
      const scope = analyze(ast, {
        ecmaVersion: 2022,
        sourceType: script.mode,
        nodejsScope: false,
        optimistic: false,
        ignoreEval: false,
        impliedStrict: false,
      });
      for (const fn of functions) {
        if (
          scope
            .getDeclaredVariables(fn)
            .some(
              (variable) =>
                !variable.scope.isStrict &&
                (variable.scope.type === 'block' || variable.scope.type === 'switch'),
            )
        )
          return { ok: false, kind: 'unsupported', scriptIndex: script.index };
      }
      if (script.mode === 'script') {
        for (const variable of scope.globalScope.variables) names.add(variable.name);
      }
      parsed.push({ ...script, parents, scope });
    }

    for (const script of parsed) {
      currentScript = script.index;
      for (const reference of script.scope.globalScope.through) {
        if (names.has(reference.identifier.name)) continue;
        const parent = script.parents.get(reference.identifier.start);
        // Bare typeof/delete of an absent name does not throw. Members/calls still read the base.
        if (
          parent?.type === 'UnaryExpression' &&
          (parent.operator === 'typeof' || parent.operator === 'delete') &&
          parent.argument === reference.identifier
        )
          continue;
        const kind: FailureKind = reference.isRead()
          ? 'unbound-read'
          : reference.isWrite()
            ? reference.from.isStrict
              ? 'unresolvable-write'
              : 'implicit-global-write-unsupported'
            : 'unsupported';
        const offset = script.offset + reference.identifier.start;
        const before = html.slice(0, offset);
        const lines = before.split(/\r\n|[\n\r]/);
        return {
          ok: false,
          kind,
          scriptIndex: script.index,
          line: lines.length,
          column: lines[lines.length - 1].length,
        };
      }
    }
    return {
      ok: true,
      classicScripts: scripts.filter((script) => script.mode === 'script').length,
      moduleScripts: scripts.filter((script) => script.mode === 'module').length,
    };
  } catch {
    // Never log analyzer messages, execute a fallback or accept partially checked HTML.
    return { ok: false, kind: 'analysis-failed', scriptIndex: currentScript };
  }
}
