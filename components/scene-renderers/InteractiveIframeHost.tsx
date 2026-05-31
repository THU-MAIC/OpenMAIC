'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStageStore } from '@/lib/store';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import {
  useInteractiveIframePool,
  type IframePoolEntry,
} from '@/lib/store/interactive-iframe-pool';

/**
 * Stable host for interactive scene iframes (#619).
 *
 * Mounted once at the `Stage` root — outside the mode-swap / scene subtree that
 * unmounts and remounts — so the iframe elements it renders survive Pro mode
 * toggles, scene switches, and any PlaybackChromeRoot remount. The in-tree
 * `InteractiveRenderer` is only a placeholder that registers content and reports
 * the on-screen rect; the actual iframes live here, portaled to `document.body`
 * and positioned over each scene's rect via `position: fixed`.
 *
 * Body-portaled with a low z-index so it sits under Radix dialogs (e.g. the
 * scene-switch confirm) while still covering the canvas box during plain
 * interactive playback. Hidden (never unmounted) in edit mode and whenever the
 * placeholder is gone, so the document is preserved for a zero-reload return.
 */
export function InteractiveIframeHost() {
  const entries = useInteractiveIframePool((s) => s.entries);
  const activeSceneId = useInteractiveIframePool((s) => s.activeSceneId);
  const setActiveScene = useWidgetIframeStore((s) => s.setActiveScene);
  const mode = useStageStore((s) => s.mode);

  // Keep the messaging store's active scene in lock-step (its legacy fallback
  // path resolves the current widget by active scene when no id is passed).
  useEffect(() => {
    setActiveScene(activeSceneId);
  }, [activeSceneId, setActiveScene]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {Object.entries(entries).map(([sceneId, entry]) => (
        <PooledIframe
          key={sceneId}
          sceneId={sceneId}
          entry={entry}
          visible={mode !== 'edit' && entry.visible && sceneId === activeSceneId}
        />
      ))}
    </>,
    document.body,
  );
}

interface PooledIframeProps {
  readonly sceneId: string;
  readonly entry: IframePoolEntry;
  readonly visible: boolean;
}

/**
 * One persisted iframe. Stays mounted as long as its pool entry exists (only
 * evicted by LRU), so its document is preserved across scene/mode changes.
 * `srcDoc` / `src` come straight from the entry and only change when the
 * content hash changes — that is the single intended reload path.
 */
function PooledIframe({ sceneId, entry, visible }: PooledIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const registerIframe = useWidgetIframeStore((s) => s.registerIframe);

  // Register the postMessage callback for this scene (moved here from the
  // placeholder, since the iframe now lives in the host). Stable per scene:
  // the callback reads contentWindow lazily at send time.
  useEffect(() => {
    const send = (type: string, payload: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage({ type, ...payload }, '*');
    };
    registerIframe(sceneId, send);
    return () => registerIframe(sceneId, null);
  }, [sceneId, registerIframe]);

  const rect = entry.rect;
  const shown = visible && rect !== null;
  const style: CSSProperties = {
    position: 'fixed',
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    border: 0,
    borderRadius: '0.5rem', // matches the canvas box's rounded-lg
    overflow: 'hidden',
    zIndex: 1,
    // visibility (not display) — display:none can drop the document on re-show.
    visibility: shown ? 'visible' : 'hidden',
    pointerEvents: shown ? 'auto' : 'none',
  };

  return (
    <iframe
      ref={iframeRef}
      srcDoc={entry.srcDoc}
      src={entry.srcDoc ? undefined : entry.src}
      style={style}
      title={`Interactive Scene ${sceneId}`}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
  );
}
