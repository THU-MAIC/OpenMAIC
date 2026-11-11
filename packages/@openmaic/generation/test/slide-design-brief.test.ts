/**
 * The slide design brief: `outline.design` lands in the slide content user
 * prompt as its own section, after the scene information. Without a design
 * the prompt is byte-for-byte the prompt from before the section existed.
 */
import { describe, expect, it } from 'vitest';

import { buildPrompt, generateSceneContent, PROMPT_IDS } from '@openmaic/generation';
import type { AICallFn, SceneOutline } from '@openmaic/generation';

const DESIGN = '<<DESIGN-SENTINEL>> white background, navy title band, 60/40 split';

function capture(): { aiCall: AICallFn; user: () => string } {
  let user = '';
  const aiCall: AICallFn = async (_system, prompt) => {
    user = prompt;
    return JSON.stringify({ elements: [], background: null, remark: '' });
  };
  return { aiCall, user: () => user };
}

function outline(overrides: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene-1',
    type: 'slide',
    title: 'Special angles',
    description: 'Read sin, cos and tan of the special angles at a glance.',
    keyPoints: ['30, 45 and 60 degrees', 'tan is undefined at 90 degrees'],
    order: 1,
    ...overrides,
  };
}

const VARIABLES = {
  title: 'T',
  description: 'D',
  keyPoints: '1. K',
  assignedImages: 'none',
  teacherContext: '',
  languageDirective: '',
  canvas_width: 1000,
  canvas_height: 562.5,
};

describe('slide design brief', () => {
  it('adds a Design Brief section between the scene information and the resources', async () => {
    const { aiCall, user } = capture();
    await generateSceneContent(outline({ design: `  ${DESIGN}  ` }), aiCall);

    const prompt = user();
    expect(prompt).toContain('## Design Brief');
    expect(prompt).toContain(DESIGN);
    expect(prompt).not.toContain(`  ${DESIGN}  `);
    const scene = prompt.indexOf('## Scene Information');
    const design = prompt.indexOf('## Design Brief');
    const resources = prompt.indexOf('## Available Resources');
    expect(scene).toBeLessThan(design);
    expect(design).toBeLessThan(prompt.indexOf(DESIGN));
    expect(prompt.indexOf(DESIGN)).toBeLessThan(resources);
    // The design never becomes the page description.
    expect(prompt).toContain(
      '- **Description**: Read sin, cos and tan of the special angles at a glance.',
    );
  });

  it('leaves the prompt without the section when there is no design', async () => {
    for (const design of [undefined, '', '   ']) {
      const { aiCall, user } = capture();
      await generateSceneContent(outline(design === undefined ? {} : { design }), aiCall);
      expect(user()).not.toContain('Design Brief');
      expect(user()).toContain('## Available Resources');
    }
  });

  it('keeps the no-design template output identical to the template without the block', () => {
    const without = buildPrompt(PROMPT_IDS.SLIDE_CONTENT, { ...VARIABLES, design: '' });
    const withDesign = buildPrompt(PROMPT_IDS.SLIDE_CONTENT, { ...VARIABLES, design: DESIGN });
    expect(without).not.toBeNull();
    expect(withDesign).not.toBeNull();
    // The section starts after the teacher context's blank line and ends with
    // its own, so removing it leaves exactly one blank line before the resources.
    expect(without!.user).toContain('- **Key Points**:\n  1. K\n\n\n\n## Available Resources');
    const section = withDesign!.user.slice(
      withDesign!.user.indexOf('## Design Brief'),
      withDesign!.user.indexOf('## Available Resources'),
    );
    expect(withDesign!.user.replace(section, '')).toBe(without!.user);
    expect(withDesign!.system).toBe(without!.system);
  });
});
