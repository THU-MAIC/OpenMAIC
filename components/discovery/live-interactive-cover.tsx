'use client';

import { ThumbnailInteractive } from '@/components/slide-renderer/components/ThumbnailInteractive';
import { InteractiveCover } from '@/components/discovery/interactive-cover';
import { useInteractiveCoverSlot } from '@/lib/hooks/use-interactive-cover-slot';
import { firstInteractiveCover } from '@/lib/utils/course-cover';
import type { InteractiveContent, Scene } from '@/lib/types/stage';

/**
 * A slide-less course's cover: its first interactive page rendered live, in
 * the same scaled, sandboxed, non-interactive iframe the classroom sidebar
 * uses (`ThumbnailInteractive`) — so the cover shows what the page actually
 * looks like, fresh from the current scene, with no cache to go stale.
 *
 * The static placeholder (`InteractiveCover`) stands in while the card is
 * off-screen or no live slot is free — a page caps how many interactive
 * iframes run at once (`useInteractiveCoverSlot`) — and for a page with
 * neither HTML nor a URL to render.
 */
export function LiveInteractiveCover({
  scene,
  size,
  compact = false,
  visible,
}: {
  /** The course's first interactive scene, as the loader read it. */
  readonly scene: Scene;
  /** Inner pixel width the iframe scales into, like a slide thumbnail's. */
  readonly size: number;
  /** Placeholder mode for the smallest covers (the 64px chat chip). */
  readonly compact?: boolean;
  /** Whether the card is near the viewport; live covers render only on screen. */
  readonly visible: boolean;
}) {
  const content = scene.content as InteractiveContent;
  const renderable = Boolean(content.html || content.url);
  const holding = useInteractiveCoverSlot(
    visible && renderable && content.type === 'interactive' ? scene.stageId : null,
  );
  if (!holding || content.type !== 'interactive') {
    const cover = firstInteractiveCover([scene]);
    return cover ? <InteractiveCover cover={cover} compact={compact} /> : null;
  }
  return <ThumbnailInteractive content={content} size={size} />;
}
