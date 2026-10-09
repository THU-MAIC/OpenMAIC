// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { PPTVideoElement, Slide } from '@openmaic/dsl';

// The canvas itself is the renderer's; here it only hands each video to the scene.
vi.mock('@openmaic/renderer', () => ({
  SlideCanvas: ({
    slide,
    renderVideo,
  }: {
    slide: Slide;
    renderVideo: (element: PPTVideoElement) => ReactNode;
  }) =>
    createElement(
      Fragment,
      null,
      ...slide.elements.map((element) => renderVideo(element as PPTVideoElement)),
    ),
}));

import { SlideScene } from '@/lib/standalone-player/scenes/SlideScene';
import { VideoRegistry } from '@/lib/standalone-player/playback/media-ports';
import type { MediaLibrary } from '@/lib/standalone-player/playback/media-library';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerStrings,
} from '@/lib/export/standalone-html/contract';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const strings = Object.fromEntries(
  STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, `[${key}]`]),
) as StandalonePlayerStrings;

describe('SlideScene', () => {
  it('reports a video that fails to load to the media library, by its key', () => {
    const reportError = vi.fn();
    const media: MediaLibrary = {
      resolve: (key) => (key === 'media/clip.mp4' ? 'media/clip.mp4' : undefined),
      has: (key) => key === 'media/clip.mp4',
      dispose: () => {},
      reportError,
      linkedMediaMissing: () => false,
      subscribe: () => () => {},
      probeLinkedMedia: () => {},
    };
    const video = (id: string, mediaRef?: string) =>
      ({
        type: 'video',
        id,
        src: '',
        mediaRef,
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        rotate: 0,
      }) as unknown as PPTVideoElement;
    const slide = { id: 's', elements: [video('clip', 'media/clip.mp4'), video('none')] } as Slide;
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() =>
      root.render(
        createElement(SlideScene, { slide, strings, media, videos: new VideoRegistry() }),
      ),
    );
    const element = host.querySelector('video')!;
    expect(element.getAttribute('src')).toBe('media/clip.mp4');
    // The clip without bytes shows its poster note instead of a player.
    expect(host.querySelectorAll('video')).toHaveLength(1);
    expect(host.textContent).toContain('[videoUnavailable]');
    act(() => {
      element.dispatchEvent(new Event('error'));
    });
    expect(reportError).toHaveBeenCalledWith('media/clip.mp4');
    act(() => root.unmount());
  });
});
