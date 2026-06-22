import { describe, expect, it } from 'vitest';
import { changeOutlineType } from '@/lib/generation/outline-type';
import { applyOutlineFallbacks } from '@/lib/generation/outline-generator';
import type { SceneOutline } from '@/lib/types/generation';

const base: SceneOutline = {
  id: 'a',
  type: 'slide',
  title: 'Photosynthesis',
  description: 'How plants make food',
  keyPoints: ['light', 'water', 'CO2'],
  order: 1,
};

describe('changeOutlineType', () => {
  it('seeds widget config when switching to interactive', () => {
    const r = changeOutlineType(base, 'interactive');
    expect(r.type).toBe('interactive');
    expect(r.widgetType).toBe('simulation');
    expect(r.widgetOutline?.concept).toBe('Photosynthesis');
  });

  it('seeds pblConfig from shared fields when switching to pbl', () => {
    const r = changeOutlineType(base, 'pbl');
    expect(r.type).toBe('pbl');
    expect(r.pblConfig?.projectTopic).toBe('Photosynthesis');
    expect(r.pblConfig?.projectDescription).toBe('How plants make food');
    expect(r.pblConfig?.targetSkills).toEqual(['light', 'water', 'CO2']);
  });

  it('strips foreign config when switching away', () => {
    const interactive = changeOutlineType(base, 'interactive');
    const slide = changeOutlineType(interactive, 'slide');
    expect(slide.type).toBe('slide');
    expect(slide.widgetType).toBeUndefined();
    expect(slide.widgetOutline).toBeUndefined();
  });

  it('seeds default quizConfig when switching to quiz', () => {
    const r = changeOutlineType(base, 'quiz');
    expect(r.quizConfig).toEqual({
      questionCount: 3,
      difficulty: 'medium',
      questionTypes: ['single'],
    });
  });

  it('keeps an existing valid pblConfig instead of overwriting', () => {
    const withPbl = changeOutlineType(
      {
        ...base,
        type: 'pbl',
        pblConfig: { projectTopic: 'Custom', projectDescription: 'd', targetSkills: ['x'] },
      },
      'pbl',
    );
    expect(withPbl.pblConfig?.projectTopic).toBe('Custom');
  });

  it('preserves shared fields', () => {
    const r = changeOutlineType(base, 'pbl');
    expect(r.id).toBe('a');
    expect(r.title).toBe('Photosynthesis');
    expect(r.order).toBe(1);
  });

  // The bug-fix invariant: editor-produced interactive/pbl outlines must survive
  // applyOutlineFallbacks (which otherwise degrades config-less ones to slide).
  it('produces outlines that survive applyOutlineFallbacks', () => {
    expect(applyOutlineFallbacks(changeOutlineType(base, 'interactive'), true).type).toBe(
      'interactive',
    );
    expect(applyOutlineFallbacks(changeOutlineType(base, 'pbl'), true).type).toBe('pbl');
  });
});
