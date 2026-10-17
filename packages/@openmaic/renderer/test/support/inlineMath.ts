import { expect, vi } from 'vitest';
import { INLINE_MATH_ATTRIBUTE } from '../../src/utils/inlineMath';

/** Stored prose: the formula as source only. */
export function stored(latex: string): string {
  const span = document.createElement('span');
  span.setAttribute(INLINE_MATH_ATTRIBUTE, latex);
  span.textContent = latex;
  return span.outerHTML;
}

/** Formulas typeset under `root`. */
export function typesetCount(root: ParentNode): number {
  return root.querySelectorAll(`.katex[${INLINE_MATH_ATTRIBUTE}]`).length;
}

/**
 * A distinct 1×40 `pmatrix`: a short source that renders to about 45,000
 * characters of markup, so a few of them fill a batch's markup budget.
 */
export function matrix(index: number): string {
  const cells = Array.from({ length: 40 }, (_, k) => `a_{${index + k}}`).join('&');
  return `\\begin{pmatrix}${cells}\\end{pmatrix}`;
}

/**
 * Scheduled callbacks that run only when a test advances them, so frame and
 * idle boundaries are explicit instead of raced against timers.
 */
export function callbackQueue() {
  const callbacks = new Map<number, () => void>();
  let next = 0;
  const request = vi.fn((callback: () => void) => {
    next += 1;
    callbacks.set(next, callback);
    return next;
  });
  const cancel = vi.fn((handle: number) => {
    callbacks.delete(handle);
  });
  return {
    request,
    cancel,
    callbacks,
    /** Run the oldest queued callback, if any. */
    step(): void {
      const oldest = callbacks.entries().next().value;
      if (!oldest) return;
      callbacks.delete(oldest[0]);
      oldest[1]();
    },
    /** Run queued callbacks, and those they queue, until none is left. */
    flush(): void {
      for (let run = 0; run < 1_000 && callbacks.size > 0; run += 1) this.step();
      expect(callbacks.size).toBe(0);
    },
  };
}

export type CallbackQueue = ReturnType<typeof callbackQueue>;

/** Route `requestIdleCallback`/`cancelIdleCallback` through a {@link callbackQueue}. */
export function stubIdleCallbacks(): CallbackQueue {
  const queue = callbackQueue();
  vi.stubGlobal('requestIdleCallback', queue.request);
  vi.stubGlobal('cancelIdleCallback', queue.cancel);
  return queue;
}

/** Route `requestAnimationFrame`/`cancelAnimationFrame` through a {@link callbackQueue}. */
export function stubAnimationFrames(): CallbackQueue {
  const queue = callbackQueue();
  vi.stubGlobal('requestAnimationFrame', queue.request);
  vi.stubGlobal('cancelAnimationFrame', queue.cancel);
  return queue;
}
