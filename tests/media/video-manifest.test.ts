import { describe, expect, test } from 'vitest';
import {
  buildVideoManifestFromOutlines,
  getVideoMediaRefForElement,
} from '@/lib/media/video-manifest';
import type { SceneOutline } from '@/lib/types/generation';

describe('video manifest', () => {
  test('collects only generated video requests from outlines', () => {
    const outlines: SceneOutline[] = [
      {
        id: 'scene_1',
        type: 'slide',
        title: 'Motion',
        description: 'Explain a motion concept',
        keyPoints: ['motion'],
        order: 1,
        mediaGenerations: [
          {
            type: 'image',
            elementId: 'gen_img_abc123',
            prompt: 'A still diagram',
            aspectRatio: '16:9',
          },
          {
            type: 'video',
            elementId: 'gen_vid_unique1',
            prompt: 'A short animation of the motion concept',
            aspectRatio: '16:9',
          },
        ],
      },
      {
        id: 'scene_2',
        type: 'slide',
        title: 'No media',
        description: 'Explain without media',
        keyPoints: ['text only'],
        order: 2,
      },
    ];

    expect(buildVideoManifestFromOutlines(outlines)).toEqual({
      gen_vid_unique1: {
        type: 'video',
        prompt: 'A short animation of the motion concept',
        aspectRatio: '16:9',
      },
    });
  });

  test('uses mediaRef before legacy placeholder src when resolving video references', () => {
    expect(
      getVideoMediaRefForElement({
        id: 'video_1',
        type: 'video',
        left: 0,
        top: 0,
        width: 100,
        height: 56,
        rotate: 0,
        mediaRef: 'gen_vid_manifest',
        src: 'gen_vid_legacy',
        autoplay: false,
      }),
    ).toBe('gen_vid_manifest');

    expect(
      getVideoMediaRefForElement({
        id: 'video_2',
        type: 'video',
        left: 0,
        top: 0,
        width: 100,
        height: 56,
        rotate: 0,
        src: 'gen_vid_legacy',
        autoplay: false,
      }),
    ).toBe('gen_vid_legacy');

    expect(
      getVideoMediaRefForElement({
        id: 'video_3',
        type: 'video',
        left: 0,
        top: 0,
        width: 100,
        height: 56,
        rotate: 0,
        src: 'https://example.com/video.mp4',
        autoplay: false,
      }),
    ).toBeUndefined();
  });
});
