'use client';

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { motion } from 'motion/react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { rectsEqual, type LayoutRect } from './v2/host-rect';

const IMMERSIVE_LAUNCH_DURATION_SECONDS = 0.45;
// The one-time Hero → workspace launch gets a slower, more deliberate
// reveal; every later manual expand uses the snappy default above. The
// even ease (vs. the front-loaded launch ease) spreads the motion across
// the whole launch so the grow, the workspace fade-in and the backdrop
// dim progress together and the page behind fades away gradually.
const HERO_LAUNCH_EXPAND_DURATION_SECONDS = 1.3;
const HERO_LAUNCH_EXPAND_EASE = [0.4, 0, 0.2, 1] as const;
const IMMERSIVE_EXIT_DURATION_SECONDS = 0.4;
const IMMERSIVE_LAUNCH_EASE = [0.16, 1, 0.3, 1] as const;
const IMMERSIVE_EXIT_EASE = [0.4, 0, 0.2, 1] as const;

function measureHostRect(hostRef: RefObject<HTMLDivElement | null>): LayoutRect {
  const rect = hostRef.current?.getBoundingClientRect();
  if (rect) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  if (typeof window === 'undefined') return { left: 0, top: 0, width: 0, height: 0 };
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/**
 * The single, persistent web-fullscreen frame for the workspace AND the
 * completion phases. It is portaled to <body> and `position: fixed`, so
 * it can cover the viewport when expanded while the React-tree position
 * stays stable — meaning the inner workspace (and its chat /
 * stream state) is never remounted by an expand/collapse toggle.
 *
 * Hosting both phases here is what lets the fullscreen state survive the
 * workspace → completion transition: the frame stays mounted, only its
 * inner content swaps, so the learner keeps the same docked/expanded view
 * (and its controls) instead of completion dropping back to a small box.
 *
 * - docked: the frame is positioned over the host (scene) box, with no
 *   drop-shadow/backdrop, so it looks identical to the previous inline
 *   layout.
 * - expanded: the frame animates to the viewport with a backdrop, and
 *   shows the collapse (Minimize) control.
 */
export function PBLWorkspaceLayer({
  children,
  showExpandControl = false,
  hostRef,
  expanded,
  autoExpand,
  nativeFullscreen,
  onExpandedChange,
  onAutoExpandConsumed,
}: {
  readonly children: ReactNode;
  readonly showExpandControl?: boolean;
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly expanded: boolean;
  readonly autoExpand: boolean;
  readonly nativeFullscreen: boolean;
  readonly onExpandedChange: (next: boolean) => void;
  readonly onAutoExpandConsumed: () => void;
}) {
  const { t } = useI18n();
  const [hostRect, setHostRect] = useState<LayoutRect>(() => measureHostRect(hostRef));

  // Animate ONLY the expand/collapse toggle (and the launch auto-expand).
  // Plain host-rect tracking while docked must apply instantly, otherwise
  // the frame would lag behind window/sidebar resizes.
  const prevExpandedRef = useRef(expanded);
  const isToggle = prevExpandedRef.current !== expanded;
  useEffect(() => {
    prevExpandedRef.current = expanded;
  });

  // Keep the docked frame aligned with the host (scene) box across window
  // resizes, sidebar toggles and scrolls.
  useEffect(() => {
    const host = hostRef.current;
    let raf = 0;
    let last: LayoutRect | null = null;

    // Dirty-checked apply: only push React state when the rect actually
    // changed, so the per-frame poll below stays free while the box is still.
    const sync = () => {
      const next = measureHostRect(hostRef);
      if (!last || !rectsEqual(last, next)) {
        last = next;
        setHostRect(next);
      }
    };
    sync();

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    if (observer && host) observer.observe(host);
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);

    // Side-panel toggles re-CENTER the height-constrained 16:9 host box without
    // resizing it: the box only MOVES, so ResizeObserver / resize / scroll never
    // fire and the position:fixed docked frame would stay put — leaking the
    // (correctly reflowed) box beside it. While docked, also poll the rect every
    // animation frame (a cheap getBoundingClientRect + the dirty-check above, so
    // React state changes only when the box truly moves) so the frame tracks the
    // slide. Not needed while expanded — the frame is fullscreen, not
    // host-aligned — so the loop is skipped (and torn down) in that mode.
    if (!expanded) {
      const tick = () => {
        sync();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostRef, expanded]);

  // Hero launch reveal. The layer mounts DOCKED; on the next frame we flip
  // `expanded` to true so the grow runs through the SAME prop-change animation
  // as manual maximize (reliable, and unaffected by React StrictMode's
  // mount/remount — unlike framer's mount `initial`, which it skips). Keep
  // `autoExpand` (slow 1.3s Hero timing) until the reveal has played, then
  // consume it so later manual expands use the snappy default.
  useEffect(() => {
    if (!autoExpand) return;
    const raf = requestAnimationFrame(() => onExpandedChange(true));
    const consume = window.setTimeout(
      onAutoExpandConsumed,
      HERO_LAUNCH_EXPAND_DURATION_SECONDS * 1000 + 120,
    );
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(consume);
    };
    // Re-run when `autoExpand` flips true so the reveal fires whether the flag
    // is already set at mount (the normal case) or arrives just after; the
    // callbacks are effectively stable for this one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExpand]);

  // Lock background scroll only while the workspace owns the viewport.
  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  const dockedStyle = {
    left: hostRect.left,
    top: hostRect.top,
    width: hostRect.width,
    height: hostRect.height,
    borderRadius: 8,
  };
  const fullscreenStyle = {
    left: 0,
    top: 0,
    width: '100vw',
    height: '100dvh',
    borderRadius: 0,
  };
  const animateFrame = isToggle || autoExpand;
  // `autoExpand` is true only on the first Hero launch render → that one
  // time gets the slower, evenly-paced reveal (geometry + the workspace's
  // own fade-in + the backdrop dim all share this transition, so the page
  // behind fades away gradually across the whole launch). Manual maximize
  // keeps the snappy default.
  const expandDuration = autoExpand
    ? HERO_LAUNCH_EXPAND_DURATION_SECONDS
    : IMMERSIVE_LAUNCH_DURATION_SECONDS;
  const expandEase = autoExpand ? HERO_LAUNCH_EXPAND_EASE : IMMERSIVE_LAUNCH_EASE;
  const transition = animateFrame
    ? {
        duration: expanded ? expandDuration : IMMERSIVE_EXIT_DURATION_SECONDS,
        ease: expanded ? expandEase : IMMERSIVE_EXIT_EASE,
      }
    : { duration: 0 };

  return (
    <>
      <motion.div
        className={cn(
          'pointer-events-none fixed inset-0 bg-background/80 backdrop-blur-sm',
          // Docked stays a z-auto stacking context (see the frame note); it is
          // invisible while docked anyway. Expanded dims the whole page on top.
          expanded ? 'z-[110]' : 'isolate',
        )}
        initial={false}
        animate={{ opacity: expanded ? 1 : 0 }}
        transition={transition}
      />
      <motion.div
        data-testid="pbl-workspace-frame"
        data-expanded={expanded}
        className={cn(
          'fixed overflow-hidden bg-background text-foreground',
          // Docked must behave like ordinary in-page content: NO positive
          // z-index. Header dropdowns portal to <body>, but their Radix popper
          // wrapper is z-auto (the `z-50` lives on the inner content, trapped by
          // the wrapper's transform). A positive z here (even z-1) would paint
          // over that wrapper and clip the menu. `isolate` gives the docked
          // layer a z-auto stacking context that still covers all in-app scene
          // content (it outranks the static app root) yet sits below the
          // later-mounted dropdown portal. Expanded is a full takeover on top.
          expanded ? 'z-[120]' : 'isolate',
          expanded && 'shadow-[0_24px_90px_rgba(0,0,0,0.38)] ring-1 ring-white/10',
        )}
        initial={false}
        animate={{ ...(expanded ? fullscreenStyle : dockedStyle), opacity: 1 }}
        transition={transition}
      >
        {/* Native (OS) fullscreen takes over the top-right slot: OpenMAIC's
            own exit bar is hidden for PBL, so this is the only click target
            to leave true fullscreen (Esc still works, handled by OpenMAIC).
            `document.exitFullscreen()` triggers OpenMAIC's own fullscreenchange
            cleanup (keyboard unlock etc.) — we never touch OpenMAIC code. The
            violet, borderless-ish treatment mirrors OpenMAIC's native control
            so it reads differently from the neutral web-fullscreen buttons. */}
        {nativeFullscreen ? (
          <button
            type="button"
            onClick={() => {
              document.exitFullscreen?.().catch(() => {});
            }}
            className="absolute right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-md border border-violet-300/35 bg-violet-500/20 text-violet-100 shadow-sm backdrop-blur transition-colors hover:bg-violet-500/30"
            aria-label={t('pbl.v2.workspace.exitNativeFullscreen')}
            title={t('pbl.v2.workspace.exitNativeFullscreen')}
          >
            <Minimize2 className="h-4 w-4" />
          </button>
        ) : (
          <>
            {expanded && (
              <button
                type="button"
                onClick={() => onExpandedChange(false)}
                className="absolute right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-background/75 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
                aria-label={t('pbl.v2.workspace.exitFullscreen')}
                title={t('pbl.v2.workspace.exitFullscreen')}
              >
                <Minimize2 className="h-4 w-4" />
              </button>
            )}
            {/* The Workspace carries its own in-topbar expand control, so the
                layer only needs to supply the docked → fullscreen affordance
                for Completion (which has no topbar of its own). */}
            {!expanded && showExpandControl && (
              <button
                type="button"
                onClick={() => onExpandedChange(true)}
                className="absolute right-4 top-4 z-40 flex h-8 w-8 items-center justify-center rounded-md border border-white/15 bg-background/75 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
                aria-label={t('pbl.v2.workspace.enterFullscreen')}
                title={t('pbl.v2.workspace.enterFullscreen')}
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            )}
          </>
        )}
        <div className="relative z-10 h-full w-full">{children}</div>
      </motion.div>
    </>
  );
}
