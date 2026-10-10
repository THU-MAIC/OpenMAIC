import { SlideCanvas, type SlideEffects } from '@openmaic/renderer';
import type { PPTVideoElement, Slide } from '@openmaic/dsl';
import type { StandalonePlayerStrings } from '@/lib/export/standalone-html/contract';
import type { MediaLibrary } from '../playback/media-library';
import type { VideoRegistry } from '../playback/media-ports';

/**
 * A video whose bytes the export did not embed (an export without narration,
 * or bytes that resolved nowhere) shows its poster frame, with a note so the
 * frame is not mistaken for a broken player.
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

/**
 * An embedded video, played by `play_video` actions (or the learner, through
 * its controls). Its `mediaRef` is a key of the file's media table.
 */
function EmbeddedVideo({
  element,
  src,
  videos,
  onError,
}: {
  element: PPTVideoElement;
  src: string;
  videos: VideoRegistry;
  onError: () => void;
}) {
  return (
    <video
      ref={(video) => {
        videos.register(element.id, video);
        return () => videos.register(element.id, null);
      }}
      src={src}
      poster={element.poster || undefined}
      controls
      playsInline
      preload="auto"
      onError={onError}
      className="h-full w-full bg-black object-contain"
      data-testid="slide-video"
      data-element-id={element.id}
    />
  );
}

export function SlideScene({
  slide,
  strings,
  effects,
  media,
  videos,
}: {
  slide: Slide;
  strings: StandalonePlayerStrings;
  effects?: SlideEffects;
  media: MediaLibrary;
  videos: VideoRegistry;
}) {
  return (
    <div className="absolute inset-0 p-4">
      <SlideCanvas
        slide={slide}
        effects={effects}
        videoInteractive
        renderVideo={(element) => {
          const src = media.resolve(element.mediaRef);
          return src ? (
            <EmbeddedVideo
              element={element}
              src={src}
              videos={videos}
              onError={() => media.reportError(element.mediaRef)}
            />
          ) : (
            <VideoPoster element={element} label={strings.videoUnavailable} />
          );
        }}
      />
    </div>
  );
}
