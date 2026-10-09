import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ManifestScene } from '@/lib/export/classroom-zip-types';
import { PlaybackController, type PlaybackState } from './controller';
import { createMediaLibrary, firstLinkedImage, type MediaLibrary } from './media-library';
import { NarrationPlayer, VideoRegistry, WidgetChannel } from './media-ports';

export interface Playback {
  state: PlaybackState;
  /** A file shipped next to the page (the ZIP variant) could not be loaded. */
  linkedMediaMissing: boolean;
  media: MediaLibrary;
  videos: VideoRegistry;
  widgets: WidgetChannel;
  /** Play / continue / resume. Must be called from a user gesture (click, key press). */
  play(): void;
  pause(): void;
  toggle(): void;
  dismissDiscussion(): void;
}

/**
 * Binds the playback controller to the player: one controller and one set of
 * media ports per document, reporting the scene index the app shows.
 */
export function usePlayback(
  scenes: readonly ManifestScene[],
  index: number,
  navigate: (index: number) => void,
): Playback {
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const { controller, media, narration, videos, widgets } = useMemo(() => {
    const media = createMediaLibrary(document, { linkedImage: firstLinkedImage(scenes) });
    const narration = new NarrationPlayer(media);
    const videos = new VideoRegistry();
    const widgets = new WidgetChannel();
    const controller = new PlaybackController({
      scenes,
      navigate: (next) => navigateRef.current(next),
      ports: {
        playAudio: (ref, control) => narration.play(ref, control),
        playVideo: (elementId, control) => videos.play(elementId, control),
        sendWidgetMessage: (type, payload) => widgets.send(type, payload),
      },
    });
    videos.setUserHooks({
      onUserPause: () => controller.pause(),
      onUserPlay: () => controller.play(),
    });
    return { controller, media, narration, videos, widgets };
  }, [scenes]);

  useEffect(
    () => () => {
      controller.dispose();
      narration.stop();
      media.dispose();
    },
    [controller, media, narration],
  );

  // Effects run after the commit, so the new scene's video elements and
  // iframe are registered before its actions start.
  useEffect(() => {
    controller.sceneShown(index);
  }, [controller, index]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const linkedMediaMissing = useSyncExternalStore(media.subscribe, media.linkedMediaMissing);
  useEffect(() => media.probeLinkedMedia(), [media]);

  const play = useCallback(() => {
    narration.prime();
    videos.pauseManual();
    controller.play();
  }, [controller, narration, videos]);
  const toggle = useCallback(() => {
    narration.prime();
    if (controller.getState().mode !== 'playing') videos.pauseManual();
    controller.toggle();
  }, [controller, narration, videos]);
  const pause = useCallback(() => controller.pause(), [controller]);
  const dismissDiscussion = useCallback(() => controller.dismissDiscussion(), [controller]);

  return {
    state,
    linkedMediaMissing,
    media,
    videos,
    widgets,
    play,
    pause,
    toggle,
    dismissDiscussion,
  };
}
