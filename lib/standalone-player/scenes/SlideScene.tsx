import { SlideCanvas } from '@openmaic/renderer';
import type { PPTVideoElement, Slide } from '@openmaic/dsl';
import type { StandalonePlayerStrings } from '@/lib/export/standalone-html/contract';

/**
 * Videos ship as their poster frame only (the export embeds no video bytes),
 * with a note so the frame is not mistaken for a broken player.
 */
function VideoPoster({ element, label }: { element: PPTVideoElement; label: string }) {
  return (
    <div className="relative h-full w-full overflow-hidden bg-slate-900/10">
      {element.poster && (
        <img src={element.poster} alt="" className="h-full w-full object-contain" />
      )}
      <span className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1 text-center text-[11px] text-white">
        {label}
      </span>
    </div>
  );
}

export function SlideScene({ slide, strings }: { slide: Slide; strings: StandalonePlayerStrings }) {
  return (
    <div className="absolute inset-0 p-4">
      <SlideCanvas
        slide={slide}
        videoInteractive={false}
        renderVideo={(element) => (
          <VideoPoster element={element} label={strings.videoUnavailable} />
        )}
      />
    </div>
  );
}
