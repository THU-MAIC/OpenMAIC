import { describe, expect, test } from 'vitest';
import { buildPrompt, PROMPT_IDS, processConditionalBlocks } from '@/lib/prompts';

function buildOutlinePrompt(flags: {
  hasSourceImages?: boolean;
  imageEnabled?: boolean;
  videoEnabled?: boolean;
}) {
  const imageEnabled = flags.imageEnabled ?? false;
  const videoEnabled = flags.videoEnabled ?? false;
  return buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
    requirement: 'Teach water cycle basics',
    pdfContent: 'None',
    availableImages: flags.hasSourceImages ? '- img_1: water cycle diagram' : 'No images available',
    userProfile: '',
    researchContext: 'None',
    teacherContext: '',
    hasSourceImages: flags.hasSourceImages ?? false,
    imageEnabled,
    videoEnabled,
    mediaEnabled: imageEnabled || videoEnabled,
  });
}

function buildSlidePrompt(flags: {
  imageElementEnabled?: boolean;
  generatedImageEnabled?: boolean;
  generatedVideoEnabled?: boolean;
}) {
  const generatedImageEnabled = flags.generatedImageEnabled ?? false;
  const generatedVideoEnabled = flags.generatedVideoEnabled ?? false;
  return buildPrompt(PROMPT_IDS.SLIDE_CONTENT, {
    title: 'Water Cycle',
    description: 'Explain evaporation and condensation',
    keyPoints: '1. Evaporation\\n2. Condensation',
    assignedImages: flags.imageElementEnabled ? '- img_1: source image' : 'No images available',
    canvas_width: 1000,
    canvas_height: 562.5,
    teacherContext: '',
    languageDirective: 'Teach in English.',
    imageElementEnabled: flags.imageElementEnabled ?? false,
    generatedImageEnabled,
    generatedVideoEnabled,
    mediaElementEnabled: generatedImageEnabled || generatedVideoEnabled,
  });
}

function combined(prompt: { system: string; user: string } | null) {
  expect(prompt).not.toBeNull();
  return `${prompt!.system}\n${prompt!.user}`;
}

describe('conditional blocks', () => {
  test('processConditionalBlocks includes content only when flag is truthy', () => {
    expect(processConditionalBlocks('A {{#if enabled}}INCLUDED{{/if}} B', { enabled: true })).toBe(
      'A INCLUDED B',
    );
    expect(processConditionalBlocks('A {{#if enabled}}INCLUDED{{/if}} B', { enabled: false })).toBe(
      'A  B',
    );
  });
});

describe('requirements-to-outlines media prompt conditions', () => {
  test('omits media generation instructions when image and video generation are disabled', () => {
    const text = combined(buildOutlinePrompt({ hasSourceImages: false }));

    expect(text).not.toContain('mediaGenerations');
    expect(text).not.toContain('suggestedImageIds');
    expect(text).not.toContain('gen_img_');
    expect(text).not.toContain('gen_vid_');
    expect(text).not.toContain('{{');
  });

  test('includes image generation instructions without video instructions when only images are enabled', () => {
    const text = combined(buildOutlinePrompt({ hasSourceImages: true, imageEnabled: true }));

    expect(text).toContain('suggestedImageIds');
    expect(text).toContain('mediaGenerations');
    expect(text).toContain('gen_img_1');
    expect(text).not.toContain('gen_vid_');
    expect(text).not.toContain('{{');
  });

  test('includes video generation instructions without image generation placeholders when only video is enabled', () => {
    const text = combined(buildOutlinePrompt({ videoEnabled: true }));

    expect(text).toContain('mediaGenerations');
    expect(text).toContain('gen_vid_1');
    expect(text).not.toContain('gen_img_');
    expect(text).not.toContain('suggestedImageIds');
    expect(text).not.toContain('{{');
  });

  test('includes both image and video generation instructions when both are enabled', () => {
    const text = combined(
      buildOutlinePrompt({ hasSourceImages: true, imageEnabled: true, videoEnabled: true }),
    );

    expect(text).toContain('suggestedImageIds');
    expect(text).toContain('mediaGenerations');
    expect(text).toContain('gen_img_1');
    expect(text).toContain('gen_vid_1');
    expect(text).toContain('Content Safety Guidelines');
    expect(text).not.toContain('{{');
  });
});

describe('slide-content media prompt conditions', () => {
  test('omits image and video element rules when no media resources are available', () => {
    const text = combined(buildSlidePrompt({}));

    expect(text).not.toContain('ImageElement');
    expect(text).not.toContain('VideoElement');
    expect(text).not.toContain('gen_img_');
    expect(text).not.toContain('gen_vid_');
    expect(text).not.toContain('{{');
  });

  test('allows source images without exposing generated image placeholders', () => {
    const text = combined(buildSlidePrompt({ imageElementEnabled: true }));

    expect(text).toContain('ImageElement');
    expect(text).toContain('img_1');
    expect(text).not.toContain('gen_img_');
    expect(text).not.toContain('VideoElement');
    expect(text).not.toContain('{{');
  });

  test('allows generated videos without exposing image element rules', () => {
    const text = combined(buildSlidePrompt({ generatedVideoEnabled: true }));

    expect(text).toContain('VideoElement');
    expect(text).toContain('gen_vid_1');
    expect(text).not.toContain('ImageElement');
    expect(text).not.toContain('gen_img_');
    expect(text).not.toContain('{{');
  });

  test('is shorter when all media rules are omitted', () => {
    const noMedia = combined(buildSlidePrompt({}));
    const allMedia = combined(
      buildSlidePrompt({
        imageElementEnabled: true,
        generatedImageEnabled: true,
        generatedVideoEnabled: true,
      }),
    );

    expect(noMedia.length).toBeLessThan(allMedia.length - 1000);
  });
});
