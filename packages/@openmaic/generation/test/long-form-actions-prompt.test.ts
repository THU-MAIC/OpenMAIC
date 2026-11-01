/**
 * The long-form elaboration contract lives behind `{{#if longFormMode}}` in
 * `slide-actions/system.md`, and a variable the loader is not given reads as
 * false. The brief was threaded through but the flag was not, so the whole
 * section — "never announce a conclusion without the step that produces it",
 * the concrete-instance rule, the wrong-answer move — was removed from every
 * long-form slide prompt while the surrounding code said it was enabled.
 */
import { describe, expect, it } from 'vitest';

import { generateSceneActions } from '@openmaic/generation';
import type { AICallFn, GeneratedSlideContent, SceneOutline } from '@openmaic/generation';

const ELABORATION = 'Long-Form Elaboration';
const SEGMENT_GUIDANCE = '9-16';

function slideOutline(): SceneOutline {
  return {
    id: 'scene-long-form',
    type: 'slide',
    title: 'Rate and receptor occupancy',
    description: 'Derives why the response saturates instead of rising forever.',
    keyPoints: ['a premise', 'an inference'],
    order: 7,
  };
}

const CONTENT: GeneratedSlideContent = {
  elements: [
    {
      id: 'text_title',
      type: 'text',
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      content: '<p>Rate and receptor occupancy</p>',
      defaultFontName: '',
      defaultColor: '#000',
      rotate: 0,
    },
  ],
  background: undefined,
  remark: '',
};

function captureSystem(): { aiCall: AICallFn; system: () => string } {
  let system = '';
  const aiCall: AICallFn = async (promptSystem) => {
    system = promptSystem;
    return '[]';
  };
  return { aiCall, system: () => system };
}

function context(longFormBrief?: string) {
  return {
    pageIndex: 8,
    totalPages: 29,
    allTitles: Array.from({ length: 29 }, (_, index) => `Page ${index + 1}`),
    previousSpeeches: [],
    ...(longFormBrief ? { longFormBrief } : {}),
  };
}

describe('slide actions — long-form elaboration', () => {
  it('enables the elaboration contract when a brief is supplied', async () => {
    const { aiCall, system } = captureSystem();

    await generateSceneActions(slideOutline(), CONTENT, aiCall, {
      ctx: context('- Page 8 of 29 in a single 60-minute lesson.'),
    });

    expect(system()).toContain(ELABORATION);
    expect(system()).toContain(SEGMENT_GUIDANCE);
  });

  it('leaves the short-lesson prompt untouched', async () => {
    const { aiCall, system } = captureSystem();

    await generateSceneActions(slideOutline(), CONTENT, aiCall, { ctx: context() });

    expect(system()).not.toContain(ELABORATION);
    expect(system()).not.toContain(SEGMENT_GUIDANCE);
  });
});
