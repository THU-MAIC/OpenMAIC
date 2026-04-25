import { describe, expect, test } from 'vitest';
import { generateSceneOutlinesFromRequirements } from '@/lib/generation/outline-generator';
import { generateSceneContent } from '@/lib/generation/scene-generator';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';
import type { AICallFn } from '@/lib/generation/pipeline-types';

describe('media prompt condition wiring', () => {
  test('outline generation passes media enable flags into conditional snippets', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (system, user) => {
      capturedPrompt = `${system}\n${user}`;
      return JSON.stringify({
        languageDirective: 'Teach in English.',
        outlines: [],
      });
    };

    const requirements: UserRequirements = {
      requirement: 'Teach evaporation with an animation',
    };

    const result = await generateSceneOutlinesFromRequirements(
      requirements,
      undefined,
      undefined,
      aiCall,
      undefined,
      { imageGenerationEnabled: false, videoGenerationEnabled: true },
    );

    expect(result.success).toBe(true);
    expect(capturedPrompt).toContain('gen_vid_1');
    expect(capturedPrompt).not.toContain('gen_img_');
    expect(capturedPrompt).not.toContain('suggestedImageIds');
    expect(capturedPrompt).not.toContain('{{');
  });

  test('slide content generation exposes only media element rules backed by outline media', async () => {
    let capturedPrompt = '';
    const aiCall: AICallFn = async (system, user) => {
      capturedPrompt = `${system}\n${user}`;
      return JSON.stringify({
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          {
            id: 'title',
            type: 'text',
            left: 60,
            top: 80,
            width: 880,
            height: 76,
            content: '<p style="font-size: 28px;">Evaporation</p>',
            defaultFontName: '',
            defaultColor: '#333333',
          },
        ],
      });
    };

    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Evaporation Motion',
      description: 'Explain evaporation as a moving process',
      keyPoints: ['Molecules gain energy', 'Water changes into vapor'],
      order: 1,
      mediaGenerations: [
        {
          type: 'video',
          prompt: 'Animation of water molecules evaporating',
          elementId: 'gen_vid_1',
          aspectRatio: '16:9',
        },
      ],
    };

    const result = await generateSceneContent(outline, aiCall);

    expect(result).not.toBeNull();
    expect(capturedPrompt).toContain('VideoElement');
    expect(capturedPrompt).toContain('gen_vid_1');
    expect(capturedPrompt).not.toContain('ImageElement');
    expect(capturedPrompt).not.toContain('gen_img_');
    expect(capturedPrompt).not.toContain('{{');
  });
});
