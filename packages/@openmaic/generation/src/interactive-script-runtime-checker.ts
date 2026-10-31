/**
 * Interactive Script Runtime Checker
 *
 * Complements {@link findInteractiveScriptSyntaxFailure} (syntax-only, via
 * `node:vm` compile). That check passes a page whose inline JavaScript is
 * grammatically valid but throws at runtime — exactly the two failures we have
 * actually seen in production:
 *   - `ReferenceError: canvasContainer is not defined` (a `const` the model
 *     forgot to declare; it assumed the element `id` became a global).
 *   - `TypeError: Cannot set properties of undefined (setting 'textContent')`
 *     (a slider handler reads `state[`${variable}Display`]` for a key that does
 *     not exist, because the slider was missing its `data-var` attribute).
 *
 * This checker actually executes the classic inline scripts in a minimal mock
 * DOM (no jsdom dependency) and reports the first runtime error it hits, both
 * at top-level and while simulating the `input` / `click` events the platform
 * dispatches during widget initialization. It returns `null` when the page would
 * run cleanly.
 */

import { Script, createContext, type Context } from 'node:vm';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';

export interface InteractiveScriptRuntimeFailure {
  /** 1-based index of the <script> element (counts every parsed script). */
  readonly scriptIndex: number;
  /** Where the error occurred: top-level execution, or an event simulation. */
  readonly phase: 'top-level' | 'domcontentloaded' | 'input' | 'click' | string;
  readonly message: string;
}

const CLASSIC_JAVASCRIPT_TYPES = new Set([
  '',
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

interface ScriptElement {
  readonly attributes: ReadonlyMap<string, string>;
  readonly source: string;
  readonly executable: boolean;
}

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.Element {
  return node.nodeName[0] !== '#';
}

function isTemplate(
  node: DefaultTreeAdapterTypes.Element,
): node is DefaultTreeAdapterTypes.Template {
  return node.tagName === 'template' && 'content' in node;
}

function isTextNode(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text';
}

function scriptSource(element: DefaultTreeAdapterTypes.Element): string {
  let source = '';
  for (const child of element.childNodes) {
    if (isTextNode(child)) source += child.value;
  }
  return source;
}

function scriptAttributes(
  element: DefaultTreeAdapterTypes.Element,
): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, attribute.value);
  }
  return attributes;
}

function collectScripts(
  parent: DefaultTreeAdapterTypes.ParentNode,
  inTemplate: boolean,
  scripts: ScriptElement[],
): void {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue;
    if (child.tagName === 'script') {
      scripts.push({
        attributes: scriptAttributes(child),
        source: scriptSource(child),
        executable: !inTemplate,
      });
      continue;
    }
    if (isTemplate(child)) {
      collectScripts(child.content, true, scripts);
      continue;
    }
    collectScripts(child, inTemplate, scripts);
  }
}

function extractScriptElements(markup: string): ScriptElement[] {
  const scripts: ScriptElement[] = [];
  collectScripts(parse(markup), false, scripts);
  return scripts;
}

function classicScriptType(attributes: ReadonlyMap<string, string>): string {
  const raw = (attributes.get('type') ?? '').trim().toLowerCase();
  return raw.split(';', 1)[0]!.trim();
}

function isExecutableClassicInline(script: ScriptElement): boolean {
  if (!script.executable || script.attributes.has('src')) return false;
  return CLASSIC_JAVASCRIPT_TYPES.has(classicScriptType(script.attributes));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Minimal mock DOM
// ---------------------------------------------------------------------------

interface MockHandlers {
  [type: string]: Array<{ fn: (event: unknown) => void; scriptIndex: number }>;
}

interface MockElement {
  readonly id: string;
  readonly tagName: string;
  readonly dataset: Record<string, string>;
  readonly style: Record<string, string>;
  value: string;
  clientWidth: number;
  clientHeight: number;
  classList: { add(): void; remove(): void };
  _handlers: MockHandlers;
  _ownerScript: number;
  addEventListener(type: string, fn: (event: unknown) => void): void;
  removeEventListener(): void;
  appendChild(): void;
  removeChild(): void;
  remove(): void;
  setAttribute(): void;
  getAttribute(name: string): string | null;
  getContext(): unknown;
  querySelector(): MockElement | null;
  querySelectorAll(): MockElement[];
  getBoundingClientRect(): { top: number; left: number; width: number; height: number };
  dispatchEvent(): void;
}

/**
 * Build a mock DOM from the page markup. Elements that appear in the HTML
 * (`id` and `data-*` attributes) are pre-registered so `getElementById` returns
 * them; any other id returns `null`, faithfully reproducing the browser's
 * behaviour and surfacing the "element not found" class of runtime errors.
 */
function buildMockDom(
  markup: string,
  getCurrentScriptIndex: () => number,
): {
  sandbox: Record<string, unknown>;
  context: Context;
  sliderEls: MockElement[];
  buttonEls: MockElement[];
  docHandlers: MockHandlers;
} {
  const registry = new Map<string, MockElement>();
  const sliderEls: MockElement[] = [];
  const buttonEls: MockElement[] = [];
  const elements: MockElement[] = [];

  const ctx2d = new Proxy(
    {},
    {
      get: () => () => {},
      set: () => true,
    },
  );

  function makeEl(tagName: string, id: string, attrs: ReadonlyMap<string, string>): MockElement {
    const handlers: MockHandlers = {};
    const dataset: Record<string, string> = {};
    for (const [k, v] of attrs.entries()) {
      if (k.startsWith('data-')) {
        const key = k
          .slice(5)
          .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
        dataset[key] = v;
      }
    }
    const el: MockElement = {
      id,
      tagName,
      dataset,
      style: {},
      value: '1',
      clientWidth: 800,
      clientHeight: 600,
      classList: { add() {}, remove() {} },
      _handlers: handlers,
      _ownerScript: -1,
      addEventListener(type: string, fn: (event: unknown) => void) {
        (handlers[type] ||= []).push({ fn, scriptIndex: getCurrentScriptIndex() });
      },
      removeEventListener() {},
      appendChild() {},
      removeChild() {},
      remove() {},
      setAttribute() {},
      getAttribute(name: string) {
        return attrs.get(name.toLowerCase()) ?? null;
      },
      getContext() {
        return ctx2d;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      getBoundingClientRect() {
        return { top: 0, left: 0, width: 100, height: 100 };
      },
      dispatchEvent() {},
    };
    if (dataset.var !== undefined) sliderEls.push(el);
    const typeAttr = (attrs.get('type') ?? '').toLowerCase();
    if (
      tagName === 'button' ||
      typeAttr === 'button' ||
      (attrs.get('role') ?? '').toLowerCase() === 'button'
    ) {
      buttonEls.push(el);
    }
    if (id) {
      registry.set(id, el);
      elements.push(el);
    }
    return el;
  }

  // Pre-register elements declared in the markup.
  const root = parse(markup);
  const walk = (parent: DefaultTreeAdapterTypes.ParentNode) => {
    for (const child of parent.childNodes) {
      if (!isElement(child)) continue;
      if (child.tagName === 'script' || child.tagName === 'template') {
        if (child.tagName === 'template' && 'content' in child) walk(child.content);
        continue;
      }
      const attrs = scriptAttributes(child);
      const id = attrs.get('id') ?? '';
      const tag = child.tagName;
      if (!registry.has(id) && id) makeEl(tag, id, attrs);
      walk(child);
    }
  };
  walk(root);

  const docHandlers: MockHandlers = {};

  const documentMock: Record<string, unknown> = {
    getElementById: (id: string) => registry.get(id) ?? null,
    querySelector: (sel: string) => {
      const m = /\[data-var="([^"]+)"\]/.exec(sel);
      if (m) return sliderEls.find((e) => e.dataset.var === m[1]) ?? null;
      return null;
    },
    querySelectorAll: () => [],
    createElement: (tag: string) => makeEl(tag, '', new Map()),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (docHandlers[type] ||= []).push({ fn, scriptIndex: getCurrentScriptIndex() });
    },
    body: makeEl('body', 'body', new Map()),
  };

  const windowMock: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (docHandlers[type] ||= []).push({ fn, scriptIndex: getCurrentScriptIndex() });
    },
    requestAnimationFrame: () => 0,
    devicePixelRatio: 1,
    katex: undefined,
    renderMathInElement: undefined,
  };

  const sandbox: Record<string, unknown> = {
    document: documentMock,
    window: windowMock,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    console,
    Math,
    JSON,
    Date,
    Event: class {
      type: string;
      constructor(t: string) {
        this.type = t;
      }
    },
    CustomEvent: class {
      type: string;
      detail: unknown;
      constructor(t: string, init?: { detail?: unknown }) {
        this.type = t;
        this.detail = init?.detail;
      }
    },
  };

  const context = createContext(sandbox);
  return { sandbox, context, sliderEls, buttonEls, docHandlers, elements };
}

/**
 * Execute the classic inline scripts of an interactive page in a mock DOM and
 * report the first runtime error, or `null` if the page runs cleanly.
 *
 * Errors surfaced:
 *  - top-level `ReferenceError` / `TypeError` (e.g. an undeclared variable).
 *  - the same errors thrown from the `input` / `click` handlers the platform
 *    fires during widget init (e.g. a missing `data-var` slider).
 *
 * `Promise` rejections and other async failures are intentionally NOT treated as
 * page-breaking: only synchronous throwables that blank the page are reported,
 * so well-formed pages are never falsely rejected.
 */
export function findInteractiveScriptRuntimeFailure(
  html: string,
): InteractiveScriptRuntimeFailure | null {
  const scripts = extractScriptElements(html);
  let currentScriptIndex = -1;
  const { context, sliderEls, buttonEls, docHandlers, elements } = buildMockDom(html, () => currentScriptIndex);

  for (let index = 0; index < scripts.length; index += 1) {
    const script = scripts[index]!;
    if (!isExecutableClassicInline(script) || !script.source.trim()) continue;
    currentScriptIndex = index + 1;
    try {
      new Script(script.source).runInContext(context);
    } catch (error) {
      return { scriptIndex: index + 1, phase: 'top-level', message: errorMessage(error) };
    }
  }

  const fireEvent = (
    phase: 'domcontentloaded' | 'input' | 'click',
    entries: Array<{ fn: (event: unknown) => void; scriptIndex: number }>,
    label: string,
  ): InteractiveScriptRuntimeFailure | null => {
    for (const entry of entries) {
      try {
        entry.fn({ type: phase, target: { dataset: {} } });
      } catch (error) {
        return {
          scriptIndex: entry.scriptIndex,
          phase: `${phase}:${label}`,
          message: errorMessage(error),
        };
      }
    }
    return null;
  };

  for (const [type, entries] of Object.entries(docHandlers)) {
    if (type === 'DOMContentLoaded') {
      const failure = fireEvent('domcontentloaded', entries, 'document');
      if (failure) return failure;
    }
  }

  // Fire input/click on every element that registered a handler. A slider that
  // is MISSING its data-var still attaches an input handler; the buggy handler
  // then reads an undefined key and throws. Simulating only data-var sliders
  // would miss exactly that failure, so we drive every registered control.
  for (const el of elements) {
    const inputEntries = el._handlers['input'] ?? [];
    if (inputEntries.length) {
      const failure = fireEvent('input', inputEntries, el.id || el.dataset.var || '?');
      if (failure) return failure;
    }
    const clickEntries = el._handlers['click'] ?? [];
    if (clickEntries.length) {
      const failure = fireEvent('click', clickEntries, el.id || '?');
      if (failure) return failure;
    }
  }

  return null;
}
