'use client';

import { useLayoutEffect, useMemo, type RefObject } from 'react';
import katex from 'katex';
import { safeKatexOptions } from '@openmaic/dsl';

/**
 * Inline formulas in slide prose. Stored prose carries each formula as LaTeX
 * source (`<span data-inline-math="LATEX">LATEX</span>`); older or unsaved
 * content may still carry a rendered KaTeX tree with the same attribute. The
 * renderer typesets every such span in the browser from its source.
 */
export const INLINE_MATH_ATTRIBUTE = 'data-inline-math';

/**
 * Marks an element whose injected prose is one typesetting root (a text box,
 * a shape label, a table), so callers that typeset a whole slide at once use
 * the same roots, budgets and caps as the live elements.
 */
export const INLINE_MATH_ROOT_ATTRIBUTE = 'data-inline-math-root';

/** Longest source typeset; longer sources are shown as plain LaTeX text. */
export const MAX_INLINE_MATH_SOURCE = 2_000;

/**
 * Typesetting budget per pass over one prose root, counting only formulas not
 * already in the typeset cache. Within it formulas are typeset before paint;
 * the rest are typeset in idle time, a chunk of the same size at a time, so a
 * slide packed with large formulas cannot freeze the page. Ordinary prose (a
 * text box with a few dozen short formulas) fits in one pass.
 */
export const INLINE_MATH_SYNC_SOURCE_BUDGET = 4_000;
export const INLINE_MATH_SYNC_FORMULA_BUDGET = 100;

/**
 * Hard cap per prose root, counting every formula in document order: past it,
 * formulas are shown as their LaTeX text and never typeset.
 */
export const INLINE_MATH_MAX_ROOT_SOURCE = 50_000;
export const INLINE_MATH_MAX_ROOT_FORMULAS = 1_000;

/** Formula elements this module already handled, so a repeated pass skips them. */
const handled = new WeakSet<Element>();

/**
 * Typeset formulas by source, cloned on use: React may rewrite the injected
 * markup on any re-render, and re-typesetting the same source must stay
 * cheap. Bounded by the size of the cached markup, counted in serialized
 * characters (an estimate, not heap bytes); large renders are not kept.
 */
const TYPESET_CACHE_MAX_MARKUP = 2_000_000;
const TYPESET_CACHE_MAX_ENTRY = 64_000;
const typesetCache = new Map<string, { readonly formula: Element | null; readonly size: number }>();
let typesetCacheSize = 0;

/** Typeset one formula, or `null` to keep its source as text. */
function typesetUncached(doc: Document, latex: string): Element | null {
  if (!latex.trim() || latex.length > MAX_INLINE_MATH_SOURCE) return null;
  const host = doc.createElement('span');
  try {
    // Authored input: `safeKatexOptions` forces `trust: false`, makes
    // formula-defined macros inert, bounds expansion, and builds a fresh
    // `macros` object per call (KaTeX writes global definitions into it).
    katex.render(
      latex,
      host,
      safeKatexOptions({
        displayMode: false,
        output: 'html',
        throwOnError: false,
        strict: 'ignore',
      }),
    );
  } catch {
    // KaTeX refuses to run in a quirks-mode document (no doctype); the source
    // then stays as text.
    return null;
  }
  const formula = host.firstElementChild;
  formula?.setAttribute(INLINE_MATH_ATTRIBUTE, latex);
  return formula;
}

function typeset(doc: Document, latex: string): Element | null {
  let entry = typesetCache.get(latex);
  if (entry) {
    // Refresh recency.
    typesetCache.delete(latex);
    typesetCache.set(latex, entry);
  } else {
    const formula = typesetUncached(doc, latex);
    entry = { formula, size: latex.length + (formula?.outerHTML.length ?? 0) };
    if (entry.size <= TYPESET_CACHE_MAX_ENTRY) {
      typesetCache.set(latex, entry);
      typesetCacheSize += entry.size;
      for (const [key, value] of typesetCache) {
        if (typesetCacheSize <= TYPESET_CACHE_MAX_MARKUP) break;
        typesetCache.delete(key);
        typesetCacheSize -= value.size;
      }
    }
  }
  if (!entry.formula) return null;
  return entry.formula.ownerDocument === doc
    ? (entry.formula.cloneNode(true) as Element)
    : (doc.importNode(entry.formula, true) as Element);
}

export interface RenderInlineMathOptions {
  /**
   * Typeset every formula now, ignoring the per-pass budget (the hard cap
   * still applies). For callers that capture the result right away, such as
   * slide snapshots.
   */
  readonly complete?: boolean;
}

/** Formulas shown as text because they fell past a root's hard cap. */
const capped = new WeakSet<Element>();

function showSource(element: Element, latex: string): void {
  element.textContent = latex;
  handled.add(element);
}

/** Show a formula past the hard cap as its source text, whatever it shows now. */
function showCapped(element: Element, latex: string): void {
  if (capped.has(element)) return;
  const span = (element.ownerDocument ?? document).createElement('span');
  span.setAttribute(INLINE_MATH_ATTRIBUTE, latex);
  span.textContent = latex;
  handled.add(span);
  capped.add(span);
  element.replaceWith(span);
}

/**
 * Typeset the inline formulas under `root`. Each `span[data-inline-math]` is
 * replaced by a KaTeX render of its source carrying the same attribute (the
 * editor's storage shape); a source that cannot be typeset is shown as text.
 * Returns `true` when formulas were left for a later pass by the budget.
 */
export function renderInlineMath(root: ParentNode, options: RenderInlineMathOptions = {}): boolean {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  let rootSource = 0;
  let rootFormulas = 0;
  let passSource = 0;
  let passFormulas = 0;
  let pending = false;
  for (const element of root.querySelectorAll(`span[${INLINE_MATH_ATTRIBUTE}]`)) {
    // Inside a formula replaced earlier in this pass.
    if (!(root as Node).contains(element)) continue;
    const latex = element.getAttribute(INLINE_MATH_ATTRIBUTE) ?? '';
    rootSource += latex.length;
    rootFormulas += 1;
    // The cap depends only on document order within the root, so a formula
    // ends up the same whatever earlier passes did with it.
    if (rootSource > INLINE_MATH_MAX_ROOT_SOURCE || rootFormulas > INLINE_MATH_MAX_ROOT_FORMULAS) {
      showCapped(element, latex);
      continue;
    }
    if (handled.has(element) && !capped.has(element)) continue;
    if (!typesetCache.has(latex)) {
      if (
        !options.complete &&
        passFormulas > 0 &&
        (passSource + latex.length > INLINE_MATH_SYNC_SOURCE_BUDGET ||
          passFormulas >= INLINE_MATH_SYNC_FORMULA_BUDGET)
      ) {
        pending = true;
        continue;
      }
      passSource += latex.length;
      passFormulas += 1;
    }
    const formula = typeset(doc, latex);
    if (!formula) {
      showSource(element, latex);
      continue;
    }
    handled.add(formula);
    element.replaceWith(formula);
  }
  return pending;
}

/**
 * Typeset every formula under `container` now, root by root (each element
 * marked with {@link INLINE_MATH_ROOT_ATTRIBUTE}), so each root keeps its own
 * hard cap exactly as the live elements apply it. For snapshots, which
 * capture right away instead of waiting for idle time.
 */
export function completeInlineMath(container: Element): void {
  const roots = [...container.querySelectorAll(`[${INLINE_MATH_ROOT_ATTRIBUTE}]`)];
  if (container.hasAttribute(INLINE_MATH_ROOT_ATTRIBUTE)) roots.unshift(container);
  for (const root of roots) renderInlineMath(root, { complete: true });
}

/**
 * A `dangerouslySetInnerHTML` value that keeps its identity while `html` is
 * unchanged. React rewrites injected markup whenever it receives a new value
 * object, which would discard typeset formulas and any idle progress on each
 * re-render; a stable value leaves the DOM alone.
 */
export function useInnerHtml(html: string): { __html: string } {
  return useMemo(() => ({ __html: html }), [html]);
}

/** {@link useInnerHtml} for a grid of cells (table text), keyed on every cell's markup. */
export function useInnerHtmlGrid(cells: readonly (readonly string[])[]): { __html: string }[][] {
  const key = JSON.stringify(cells);
  return useMemo(
    () => (JSON.parse(key) as string[][]).map((row) => row.map((html) => ({ __html: html }))),
    [key],
  );
}

type IdleHandle = { cancel(): void };

function whenIdle(run: () => void): IdleHandle {
  const scope = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (scope.requestIdleCallback && scope.cancelIdleCallback) {
    const handle = scope.requestIdleCallback(run, { timeout: 500 });
    return { cancel: () => scope.cancelIdleCallback!(handle) };
  }
  const handle = setTimeout(run, 16);
  return { cancel: () => clearTimeout(handle) };
}

/** Typeset what a pass left over, one budget-sized chunk per idle period. */
function finishWhenIdle(root: Element): () => void {
  let handle: IdleHandle | null = null;
  const step = () => {
    handle = null;
    if (!root.isConnected) return;
    if (renderInlineMath(root)) handle = whenIdle(step);
  };
  handle = whenIdle(step);
  return () => handle?.cancel();
}

/**
 * Typeset the inline formulas of prose injected into `ref` as `html`. Runs
 * after every commit, before paint: React may rewrite the injected markup on
 * any re-render (not only when `html` changes), which would put the stored
 * source spans back. Formulas already typeset are skipped and cached renders
 * are cloned, so a commit that left the markup alone costs one query. What the
 * budget leaves over is typeset in idle time; the next commit, an unmount or
 * new content cancels that and starts over from the markup then in place.
 * Never updates React state.
 */
export function useInlineMath(ref: RefObject<Element | null>, html: string): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !html.includes(INLINE_MATH_ATTRIBUTE)) return;
    if (renderInlineMath(root)) return finishWhenIdle(root);
  });
}
