import { useCallback, useRef } from 'react';
import {
  GENUI_LOGICAL_HEIGHT,
  GENUI_LOGICAL_WIDTH,
  fitGenUiViewport,
} from '@/lib/interactive/logical-viewport';
import {
  STANDALONE_INTERACTIVE_SANDBOX,
  type StandalonePlayerStrings,
} from '@/lib/export/standalone-html/contract';
import { useElementSize } from '../use-element-size';
import type { WidgetChannel } from '../playback/media-ports';

/**
 * An interactive scene: the exported page in a sandboxed `srcdoc` iframe,
 * laid out at the fixed logical viewport generated pages are authored against
 * and scaled to fit, as in the classroom. The sandbox never grants
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
  const attachFrame = useCallback(
    (frame: HTMLIFrameElement | null) => {
      widgets.attach(frame);
      return () => widgets.attach(null);
    },
    [widgets],
  );
  const { width, height } = useElementSize(slotRef);
  const { box, scale } = fitGenUiViewport({ left: 0, top: 0, width, height });
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
              width: GENUI_LOGICAL_WIDTH,
              height: GENUI_LOGICAL_HEIGHT,
              border: 0,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
        </div>
      </div>
    </div>
  );
}
