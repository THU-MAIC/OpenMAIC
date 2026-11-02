import { describe, expect, it } from 'vitest';
import type {
  AICallFn,
  SceneContentOptions,
  SceneOutline,
  SlideContentPromptOptions,
} from '@openmaic/generation';
import { generateSceneContent, renderScenePrompt } from '@openmaic/generation';
import { slideOutline } from './scene-fixtures.js';

const emptySlide = JSON.stringify({ elements: [], background: { type: 'solid', color: '#fff' } });

async function capturedSystemPrompt(
  outline: SceneOutline,
  options?: SceneContentOptions,
): Promise<string> {
  let system: string | undefined;
  const aiCall: AICallFn = async (systemPrompt) => {
    system = systemPrompt;
    return emptySlide;
  };
  await generateSceneContent(outline, aiCall, options);
  if (system === undefined) throw new Error('the model was not called');
  return system;
}

interface PromptCase {
  name: string;
  outline: SceneOutline;
  options?: SceneContentOptions;
  flags: SlideContentPromptOptions;
}

describe('renderScenePrompt', () => {
  it.each<PromptCase>([
    {
      name: 'no media',
      outline: slideOutline(),
      options: undefined,
      flags: {
        imageElementEnabled: false,
        generatedImageEnabled: false,
        generatedVideoEnabled: false,
      },
    },
    {
      name: 'assigned images',
      outline: slideOutline(),
      options: {
        assignedImages: [{ id: 'img_1', src: '', pageNumber: 1, description: 'A diagram' }],
        imageMapping: { img_1: 'https://example.com/1.png' },
      },
      flags: {
        imageElementEnabled: true,
        generatedImageEnabled: false,
        generatedVideoEnabled: false,
      },
    },
    {
      name: 'generated image',
      outline: {
        ...slideOutline(),
        mediaGenerations: [
          {
            type: 'image',
            prompt: 'A wiring diagram',
            elementId: 'gen_img_1',
            aspectRatio: '16:9',
          },
        ],
      },
      options: undefined,
      flags: {
        imageElementEnabled: true,
        generatedImageEnabled: true,
        generatedVideoEnabled: false,
      },
    },
    {
      name: 'generated video',
      outline: {
        ...slideOutline(),
        mediaGenerations: [
          { type: 'video', prompt: 'An animation', elementId: 'gen_vid_1', aspectRatio: '16:9' },
        ],
      },
      options: undefined,
      flags: {
        imageElementEnabled: false,
        generatedImageEnabled: false,
        generatedVideoEnabled: true,
      },
    },
  ])(
    'matches the slide system prompt sent to the model with $name',
    async ({ outline, options, flags }) => {
      const rendered = renderScenePrompt('slide-content', flags);

      expect(rendered).toEqual({ system: await capturedSystemPrompt(outline, options) });
      expect(rendered.system).not.toContain('{{');
    },
  );

  it('varies only with the media flags', () => {
    const none = renderScenePrompt('slide-content', {
      imageElementEnabled: false,
      generatedImageEnabled: false,
      generatedVideoEnabled: false,
    });
    const video = renderScenePrompt('slide-content', {
      imageElementEnabled: false,
      generatedImageEnabled: false,
      generatedVideoEnabled: true,
    });

    expect(video.system).not.toBe(none.system);
    expect(video.system).toContain('VideoElement');
    expect(none.system).not.toContain('VideoElement');
  });
});
