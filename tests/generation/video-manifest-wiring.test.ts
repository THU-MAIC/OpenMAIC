import { describe, expect, test } from 'vitest';
import { generateSceneContent } from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { GeneratedSlideContent, SceneOutline } from '@/lib/types/generation';

describe('video manifest wiring', () => {
  test('corrects an invalid generated video src to the only available mediaRef', async () => {
    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Horse Motion',
      description: 'Show a happy horse running',
      keyPoints: ['horse gait', 'motion'],
      order: 1,
      mediaGenerations: [
        {
          type: 'video',
          prompt: 'A happy horse running in a sunny field',
          elementId: 'gen_vid_real123',
          aspectRatio: '16:9',
        },
      ],
    };

    const aiCall: AICallFn = async () =>
      JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          {
            id: 'video_001',
            type: 'video',
            left: 120,
            top: 120,
            width: 640,
            height: 360,
            src: 'gen_vid_1',
            autoplay: false,
          },
        ],
      });

    const content = await generateSceneContent(outline, aiCall);

    expect(content).not.toBeNull();
    const slideContent = content as GeneratedSlideContent;
    const video = slideContent.elements.find((el) => el.type === 'video');
    expect(video).toMatchObject({
      type: 'video',
      mediaRef: 'gen_vid_real123',
    });
    expect(Object.prototype.hasOwnProperty.call(video, 'src')).toBe(false);
  });

  test('removes hallucinated generated video refs when no generated videos are available', async () => {
    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Text-only scene',
      description: 'Explain without generated media',
      keyPoints: ['no media'],
      order: 1,
    };

    const aiCall: AICallFn = async () =>
      JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          {
            id: 'video_001',
            type: 'video',
            left: 120,
            top: 120,
            width: 640,
            height: 360,
            mediaRef: 'gen_vid_fake',
            autoplay: false,
          },
        ],
      });

    const content = await generateSceneContent(outline, aiCall);

    expect(content).not.toBeNull();
    const slideContent = content as GeneratedSlideContent;
    expect(slideContent.elements.some((el) => el.type === 'video')).toBe(false);
  });

  test('preserves direct video src and drops generated mediaRef', async () => {
    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Existing video',
      description: 'Use a direct video URL',
      keyPoints: ['direct video'],
      order: 1,
      mediaGenerations: [
        {
          type: 'video',
          prompt: 'A generated fallback video',
          elementId: 'gen_vid_real123',
          aspectRatio: '16:9',
        },
      ],
    };

    const aiCall: AICallFn = async () =>
      JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          {
            id: 'video_001',
            type: 'video',
            left: 120,
            top: 120,
            width: 640,
            height: 360,
            src: 'https://example.com/direct.mp4',
            mediaRef: 'gen_vid_real123',
            autoplay: false,
          },
        ],
      });

    const content = await generateSceneContent(outline, aiCall);

    expect(content).not.toBeNull();
    const slideContent = content as GeneratedSlideContent;
    const video = slideContent.elements.find((el) => el.type === 'video');
    expect(video).toMatchObject({
      type: 'video',
      src: 'https://example.com/direct.mp4',
    });
    expect(Object.prototype.hasOwnProperty.call(video, 'mediaRef')).toBe(false);
  });
});
