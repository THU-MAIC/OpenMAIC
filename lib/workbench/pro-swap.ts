'use client';

/**
 * The Pro ↔ classic swap: a quiet route handoff with the product lockup and
 * its Pro badge carried across it.
 *
 * `/` and `/workspace` are separate routes, so switching modes used to be a
 * cut — the whole page vanished and a different one appeared, and the fact
 * that the two surfaces are the same product was something the user had to
 * reconstruct. The stable identity (the OpenMAIC lockup and Pro badge) moves
 * between its two real positions while each working surface hands off with a
 * restrained directional dissolve. The composer turns over: the two faces of
 * the one object both surfaces are about. An earlier round STRETCHED that card
 * across the route change and it read as showy, because morphing a large,
 * structurally different card into another one claims the two are one object
 * deforming. A flip claims one object with two faces, which is what this is;
 * see `components/workbench/pro-swap.css` for how the size difference is kept
 * out of sight.
 *
 * Why a module and not a hook: the element that STARTS the swap lives on the
 * page that is leaving, and unmounts halfway through it. State that has to
 * outlive the navigation cannot live in that component, so it lives here, and
 * `ProSwapWatcher` — mounted in the root layout, which does not unmount —
 * reports when the new route has arrived.
 *
 * The failure modes this is written against, in order of how bad they are:
 *
 *  1. STUCK PAGE. `startViewTransition` freezes rendering until the callback's
 *     promise settles, so a promise that waits for a navigation that never
 *     lands is a frozen tab. Every wait is raced against `SETTLE_TIMEOUT_MS`,
 *     and the timer is the only thing that must never fail to run.
 *  2. HALF-FADED PAGE. `data-pro-swap` on <html> is what turns the morph on;
 *     if it survived the transition, two elements would fight for one
 *     `view-transition-name` on the next swap and the API would skip it. It is
 *     removed from `finished`, which settles on success, on skip and on abort.
 *  3. DOUBLE CLICK. A second swap while one is running is dropped, not queued:
 *     re-entering `startViewTransition` mid-transition skips the first one and
 *     the user sees a flash for a click they made by accident.
 */

const SWAP_ATTR = 'data-pro-swap';

/** How long the swap is allowed to wait for the new route before it gives up
 *  and plays against whatever is on screen. Long enough for a prefetched
 *  client navigation (tens of ms), short enough that a cold route compile in
 *  dev cannot hold the frame. */
const SETTLE_TIMEOUT_MS = 600;

type ViewTransition = {
  readonly finished: Promise<void>;
  readonly ready: Promise<void>;
  skipTransition: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransition;
};

let pending: { path: string; arrive: () => void } | null = null;
let running = false;
let startedAt = 0;

/** How long after a swap starts a newly mounted surface still counts as
 *  "arrived by swap". Comfortably longer than the transition and shorter than
 *  any plausible second visit, and only ever used to SUPPRESS an entrance
 *  animation — the cost of being wrong in either direction is one missing or
 *  one extra 620ms fade, never a broken page. */
const ARRIVAL_WINDOW_MS = 1500;

/** Called by `ProSwapWatcher` on every pathname change. */
export function proSwapArrived(pathname: string): void {
  if (pending && pending.path === pathname) pending.arrive();
}

/** True while a swap is animating — the guard against a double click. */
export function isProSwapRunning(): boolean {
  return running;
}

/**
 * Whether the surface mounting right now got here through a swap.
 *
 * Both home surfaces stagger themselves in on load (`ws-enter` here, framer
 * `initial` on `/`). That entrance is right for someone opening the page and
 * wrong for someone who just watched the page handoff settle: its composer
 * would then spend another 620ms rising into itself. A surface that arrived
 * by swap skips its entrance and is simply there.
 *
 * Deliberately idempotent — it reads a clock, it does not consume a token — so
 * that a double-invoked render (StrictMode) cannot get two different answers.
 */
export function arrivedByProSwap(): boolean {
  return startedAt > 0 && Date.now() - startedAt < ARRIVAL_WINDOW_MS;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Navigate between `/` and `/workspace` with the shared-element swap.
 *
 * `push` is the caller's `router.push`, so this module stays out of the
 * Next-router import graph and can be unit-tested with a plain function.
 * Falls back to a plain navigation — no motion, no attribute, no waiting —
 * when the browser has no View Transitions or the user asked for less motion.
 */
export function startProSwap(href: string, push: (href: string) => void): void {
  if (running) return;

  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    push(href);
    return;
  }

  const target = new URL(href, window.location.origin).pathname;
  const root = document.documentElement;

  // Set BEFORE `startViewTransition`, because the old snapshot is taken
  // synchronously inside that call and the morph names have to be on the
  // elements by then.
  root.setAttribute(SWAP_ATTR, target === '/workspace' ? 'enter' : 'exit');
  running = true;
  startedAt = Date.now();

  const transition = doc.startViewTransition(
    () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pending = null;
          resolve();
        }, SETTLE_TIMEOUT_MS);
        pending = {
          path: target,
          arrive: () => {
            clearTimeout(timer);
            pending = null;
            resolve();
          },
        };
        push(href);
      }),
  );

  const settle = () => {
    running = false;
    pending = null;
    root.removeAttribute(SWAP_ATTR);
  };
  transition.finished.then(settle, settle);
}
