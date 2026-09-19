import { useEffect, useState, type RefObject } from 'react';

/** Extra vertical slack around the viewport that still counts as "near". */
const NEAR_VIEWPORT_MARGIN_PX = 200;

/**
 * Cheap "near viewport" IntersectionObserver so off-screen thumbnails skip the
 * live slide-canvas render (which mounts a downscaled slide-renderer scene).
 * Items within 200px of the viewport render eagerly so scrolling feels instant.
 *
 * The initial state is `false`: a sidebar opening with many scenes must not
 * mount a full slide canvas for every item before the observer answers. The
 * observer's initial delivery (guaranteed on `observe`) flips near-viewport
 * items to their canvas within a frame.
 *
 * Shared by the editor nav rail and the playback scene sidebar.
 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No observer support (e.g. jsdom): fall back to always-render. Deferred
      // to a microtask so the effect only subscribes, never synchronously
      // re-renders.
      queueMicrotask(() => setVisible(true));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { root: null, rootMargin: `${NEAR_VIEWPORT_MARGIN_PX}px 0px`, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return visible;
}
