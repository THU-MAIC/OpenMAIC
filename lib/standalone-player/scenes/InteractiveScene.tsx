import { useRef } from 'react';
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

/**
 * An interactive scene: the exported page in a sandboxed `srcdoc` iframe,
 * laid out at the fixed logical viewport generated pages are authored against
 * and scaled to fit, as in the classroom. The sandbox never grants
 * `allow-same-origin`, so the page cannot reach the player's document.
 */
export function InteractiveScene({
  html,
  title,
  strings,
}: {
  html: string;
  title: string;
  strings: StandalonePlayerStrings;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
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
