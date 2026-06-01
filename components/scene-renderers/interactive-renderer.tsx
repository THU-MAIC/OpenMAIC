'use client';

import { useMemo, useRef, useEffect } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly sceneId: string;
}

/**
 * Placeholder for an interactive scene. The actual iframe lives in the stable
 * `InteractiveIframeHost` (keyed by sceneId) so it survives remounts (#619);
 * this component only (1) registers the scene's content in the keep-alive pool,
 * (2) marks it active/visible while mounted, and (3) reports its on-screen rect
 * so the host can position the iframe over this slot. On unmount it hides the
 * iframe but never evicts it — that preserves the document for a zero-reload
 * return on the next mount.
 */
export function InteractiveRenderer({ content, sceneId }: InteractiveRendererProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const mount = useInteractiveIframePool((s) => s.mount);
  const setRect = useInteractiveIframePool((s) => s.setRect);
  const show = useInteractiveIframePool((s) => s.show);
  const hide = useInteractiveIframePool((s) => s.hide);
  const setActive = useInteractiveIframePool((s) => s.setActive);

  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  // Register / activate / show in the pool while mounted; hide (keep-alive) on
  // unmount. A content change re-runs this and rebuilds the iframe — the only
  // intended reload path.
  useEffect(() => {
    mount(sceneId, {
      srcDoc: patchedHtml,
      src: patchedHtml ? undefined : content.url,
    });
    setActive(sceneId);
    show(sceneId);
    return () => hide(sceneId);
  }, [sceneId, patchedHtml, content.url, mount, setActive, show, hide]);

  // Track this slot's screen rect for the host. rAF loop mirrors useTrackedRect:
  // one getBoundingClientRect read resolves canvas scale, viewport offset and
  // scroll, following the box through every resize / layout change.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const node = slotRef.current;
      if (node) {
        const r = node.getBoundingClientRect();
        setRect(sceneId, { left: r.left, top: r.top, width: r.width, height: r.height });
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [sceneId, setRect]);

  return <div ref={slotRef} className="w-full h-full" aria-hidden />;
}
