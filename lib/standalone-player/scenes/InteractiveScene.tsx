import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  GENUI_FIT_REPORT_REQUEST,
  GENUI_FIT_SCROLL_REQUEST,
  useGenUiFit,
} from '@/lib/interactive/use-genui-fit';
import {
  STANDALONE_INTERACTIVE_SANDBOX,
  type StandalonePlayerStrings,
} from '@/lib/export/standalone-html/contract';
import { useElementSize } from '../use-element-size';
import type { WidgetChannel } from '../playback/media-ports';

/**
 * An interactive scene: the exported page in a sandboxed `srcdoc` iframe,
 * laid out at a logical viewport of at least the 1280×720 generated pages are
 * authored against, taking the slot's aspect and scaled to fill it, as in the
 * classroom. As there, a page whose content outgrows that viewport is shrunk
 * (down to a floor) to fit unscrolled, with a "more below" cue past it. The sandbox never grants
 * `allow-same-origin`, so the page cannot reach the player's document.
 *
 * Widget actions reach the page the way the classroom sends them: a
 * `postMessage` to the frame (see {@link WidgetChannel}), which the opaque
 * origin still receives.
 */
export function InteractiveScene({
  html,
  title,
  strings,
  widgets,
}: {
  html: string;
  title: string;
  strings: StandalonePlayerStrings;
  widgets: WidgetChannel;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const attachFrame = useCallback(
    (frame: HTMLIFrameElement | null) => {
      frameRef.current = frame;
      widgets.attach(frame);
      return () => {
        frameRef.current = null;
        widgets.attach(null);
      };
    },
    [widgets],
  );
  const { width, height } = useElementSize(slotRef);
  const slot = useMemo(() => ({ left: 0, top: 0, width, height }), [width, height]);
  const { viewport, showMoreCue, handleMessage, fitKey } = useGenUiFit(slot, html);
  const { box, scale, width: frameWidth, height: frameHeight } = viewport!;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source && event.source === frameRef.current?.contentWindow) {
        handleMessage(event.data);
      }
    };
    window.addEventListener('message', onMessage);
    frameRef.current?.contentWindow?.postMessage(GENUI_FIT_REPORT_REQUEST, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [handleMessage, fitKey]);
  return (
    <div className="absolute inset-0 p-4">
      <div ref={slotRef} className="relative h-full w-full">
        <div
          className="absolute overflow-hidden rounded-lg bg-white shadow-sm"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          <iframe
            ref={attachFrame}
            onLoad={(event) => widgets.markLoaded(event.currentTarget)}
            srcDoc={html}
            sandbox={STANDALONE_INTERACTIVE_SANDBOX}
            title={title || strings.interactiveTitle}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: frameWidth,
              height: frameHeight,
              border: 0,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
          {showMoreCue ? (
            <button
              type="button"
              data-testid="interactive-more-below"
              onClick={() =>
                frameRef.current?.contentWindow?.postMessage(GENUI_FIT_SCROLL_REQUEST, '*')
              }
              className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-200 bg-white/90 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm hover:text-slate-900"
            >
              <ChevronDown aria-hidden className="size-3.5" />
              {strings.interactiveMoreBelow}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
