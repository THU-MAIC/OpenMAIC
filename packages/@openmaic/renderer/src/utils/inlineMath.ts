'use client';

import { createContext, useContext, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
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
 * Bound uncached typesetting work in a batch. Live prose roots share a batch;
 * standalone renderInlineMath calls get their own. Ordinary slides fit before
 * paint; mixed/dense slides may defer even short formulas to idle time.
 */
export const INLINE_MATH_SYNC_SOURCE_BUDGET = 4_000;
export const INLINE_MATH_SYNC_FORMULA_BUDGET = 100;

/**
 * Also bound inserted markup, including cache hits: short matrix sources can
 * expand to thousands of nodes whose style/layout cost comes after typesetting.
 * Uses the serialized size already recorded by the cache, not a DOM traversal.
 * Leave room for dense ordinary slides (e.g. 32 integrals/sums across text boxes).
 */
const INLINE_MATH_SYNC_MARKUP_BUDGET = 256_000;

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
type TypesetEntry = { readonly formula: Element | null; readonly size: number };
const typesetCache = new Map<string, TypesetEntry>();
let typesetCacheSize = 0;
// Keep a rejected render with its source node until it can be inserted. Unlike
// the shared cache, this also covers large entries and cannot be overwritten by
// another root. Replacing/removing the prose releases its pending renders.
const deferredTypesets = new WeakMap<Element, { latex: string; entry: TypesetEntry }>();

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

function typeset(doc: Document, latex: string): TypesetEntry {
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
  return entry;
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
  return renderPass(root, options, newBudget());
}

type TypesetBudget = { source: number; formulas: number; markup: number; full: boolean };

function newBudget(): TypesetBudget {
  return { source: 0, formulas: 0, markup: 0, full: false };
}

function renderPass(
  root: ParentNode,
  options: RenderInlineMathOptions,
  budget: TypesetBudget,
): boolean {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  let rootSource = 0;
  let rootFormulas = 0;
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
    const deferred = deferredTypesets.get(element);
    const prepared = deferred?.latex === latex ? deferred.entry : undefined;
    const cached = prepared ?? typesetCache.get(latex);
    // Preserve source order within a root, but let a later root use cached
    // formulas that fit in the space left by a rejected large formula.
    if (!options.complete && (pending || (budget.full && !cached))) {
      pending = true;
      continue;
    }
    if (!cached) {
      if (
        !options.complete &&
        budget.formulas > 0 &&
        (budget.source + latex.length > INLINE_MATH_SYNC_SOURCE_BUDGET ||
          budget.formulas >= INLINE_MATH_SYNC_FORMULA_BUDGET)
      ) {
        budget.full = true;
        pending = true;
        continue;
      }
      budget.source += latex.length;
      budget.formulas += 1;
    }
    const entry = prepared ?? typeset(doc, latex);
    if (!entry.formula) {
      showSource(element, latex);
      continue;
    }
    // Always allow one formula to make progress, even if it exceeds a batch.
    if (
      !options.complete &&
      budget.markup > 0 &&
      budget.markup + entry.size > INLINE_MATH_SYNC_MARKUP_BUDGET
    ) {
      budget.full = true;
      pending = true;
      deferredTypesets.set(element, { latex, entry });
      continue;
    }
    budget.markup += entry.size;
    const formula =
      entry.formula.ownerDocument === doc
        ? (entry.formula.cloneNode(true) as Element)
        : (doc.importNode(entry.formula, true) as Element);
    handled.add(formula);
    deferredTypesets.delete(element);
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

type IdleScope = typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Run `run` when the page is idle. The scheduling functions are read once,
 * here, and the handle is always cancelled with the function from the same
 * pair: the global may be replaced or removed between scheduling and
 * cancelling (polyfills, test stubs), and a handle from one implementation
 * means nothing to another.
 */
function whenIdle(run: () => void): IdleHandle {
  const scope = globalThis as IdleScope;
  const request = scope.requestIdleCallback;
  const cancel = scope.cancelIdleCallback;
  if (typeof request === 'function' && typeof cancel === 'function') {
    const handle = request.call(scope, run, { timeout: 500 });
    return { cancel: () => cancel.call(scope, handle) };
  }
  const schedule = scope.setTimeout;
  const clear = scope.clearTimeout;
  const handle = schedule.call(scope, run, 16);
  return { cancel: () => clear.call(scope, handle) };
}

type MathPriority = 'normal' | 'background';
export const InlineMathPriorityContext = createContext<MathPriority>('normal');

/**
 * Own the live queues and frame allowances. Background roots share a copy of
 * the remaining foreground allowance, so an earlier thumbnail commit cannot
 * spend the next foreground commit's budget. Neither is renewed on removal.
 */
function createLiveMath() {
  // Idle work rotates roots within each priority, with foreground canvases first.
  const queuedRoots = new Map<Element, MathPriority>();
  // Only newly admitted background roots may spend the remaining frame allowance.
  const prePaintCandidates = new Set<Element>();
  let frameBudget: TypesetBudget | null = null;
  let backgroundBudget: TypesetBudget | null = null;
  let cancelFrameReset: (() => void) | null = null;
  let idleJob: { cancel?: () => void } | null = null;
  let prePaintScheduled = false;

  function resetFrameBudget(): void {
    cancelFrameReset?.();
    cancelFrameReset = null;
    frameBudget = null;
    backgroundBudget = null;
  }

  function frameAllowance(): TypesetBudget {
    if (!frameBudget) {
      const budget = (frameBudget = newBudget());
      const reset = () => {
        if (frameBudget === budget) {
          frameBudget = null;
          backgroundBudget = null;
          cancelFrameReset = null;
        }
      };
      if (
        typeof requestAnimationFrame === 'function' &&
        typeof cancelAnimationFrame === 'function'
      ) {
        const cancel = cancelAnimationFrame;
        const handle = requestAnimationFrame(reset);
        cancelFrameReset = () => cancel(handle);
      } else {
        const cancel = clearTimeout;
        const handle = setTimeout(reset, 16);
        cancelFrameReset = () => cancel(handle);
      }
    }
    return frameBudget;
  }

  function renderIdleRoots(priority: MathPriority, budget: TypesetBudget): void {
    for (const [root, queuedPriority] of [...queuedRoots]) {
      if (queuedPriority !== priority) continue;
      queuedRoots.delete(root);
      if (root.isConnected && renderPass(root, {}, budget)) queuedRoots.set(root, priority);
      if (budget.full) break;
    }
  }

  function scheduleIdle(): void {
    if (!queuedRoots.size) {
      idleJob?.cancel?.();
      idleJob = null;
      return;
    }
    if (idleJob) return;
    const job: { cancel?: () => void } = {};
    idleJob = job;
    job.cancel = whenIdle(() => {
      // A cancelled callback must not drain work queued by a later mount.
      if (idleJob !== job) return;
      idleJob = null;
      resetFrameBudget();
      const budget = newBudget();
      for (const priority of ['normal', 'background'] as const) {
        renderIdleRoots(priority, budget);
        if (budget.full) break;
      }
      scheduleIdle();
    }).cancel;
  }

  function flushPrePaint(): void {
    prePaintScheduled = false;
    if (!prePaintCandidates.size) return;
    const budget = (backgroundBudget ??= { ...frameAllowance() });
    // Visit every newly admitted root: cached formulas may fit after an earlier
    // root fills the allowance. Older queued roots remain in idle time.
    for (const root of prePaintCandidates) {
      queuedRoots.delete(root);
      if (root.isConnected && renderPass(root, {}, budget)) queuedRoots.set(root, 'background');
    }
    prePaintCandidates.clear();
    scheduleIdle();
  }

  return {
    isQueued: (root: Element): boolean => queuedRoots.has(root),

    render(root: Element, priority: MathPriority): void {
      if (priority === 'background') {
        prePaintCandidates.add(root);
        if (!prePaintScheduled) {
          prePaintScheduled = true;
          queueMicrotask(flushPrePaint);
        }
        return;
      }
      prePaintCandidates.delete(root);
      if (renderPass(root, {}, frameAllowance())) queuedRoots.set(root, priority);
      else queuedRoots.delete(root);
      scheduleIdle();
    },

    remove(root: Element): void {
      prePaintCandidates.delete(root);
      queuedRoots.delete(root);
      if (!queuedRoots.size) {
        idleJob?.cancel?.();
        idleJob = null;
      }
    },
  };
}

const liveMath = createLiveMath();

/**
 * Typeset the inline formulas of prose injected into `ref` as `html`. Runs
 * after every commit, before paint: React may rewrite the injected markup on
 * any re-render (not only when `html` changes), which would put the stored
 * source spans back. Formulas already typeset are skipped and cached renders
 * are cloned, so a commit that left the markup alone costs one query. What the
 * shared budget leaves over is typeset in idle time, using the current markup.
 * Pending roots stay in that queue on unchanged commits (including when an
 * external caller rewrites the HTML). New content can use the current frame's
 * synchronous allowance. Unmounting or replacing a root removes its queued work.
 * Foreground roots run in layout effects; background roots use the remaining
 * allowance in a microtask, following the nearest InlineMathPriorityContext.
 * Never updates React state.
 */
export function useInlineMath(ref: RefObject<Element | null>, html: string): void {
  const priority = useContext(InlineMathPriorityContext);
  const previous = useRef<{ root: Element | null; html: string; priority: MathPriority }>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const before = previous.current;
    if (before?.root && before.root !== root) liveMath.remove(before.root);
    previous.current = { root, html, priority };
    if (!root) return;
    if (!html.includes(INLINE_MATH_ATTRIBUTE)) {
      liveMath.remove(root);
      return;
    }
    if (
      before?.root === root &&
      before.html === html &&
      before.priority === priority &&
      liveMath.isQueued(root)
    )
      return;
    liveMath.render(root, priority);
  });
  // Only clean up on unmount: per-commit removal would discard pending queue
  // membership and let unchanged rerenders reenter the pre-paint path.
  useLayoutEffect(() => {
    return () => {
      if (previous.current?.root) liveMath.remove(previous.current.root);
      previous.current = null;
    };
  }, []);
}
