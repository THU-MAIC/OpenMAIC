import { describe, expect, test } from 'vitest';
import { getActionDescriptions } from '@/lib/chat/pi/tool-schemas';

describe('whiteboard LaTeX prompt guardrails', () => {
  test('wb_draw_text excludes formulas and directs equations to wb_draw_latex', () => {
    const description = getActionDescriptions(['wb_draw_text']);

    expect(description.toLowerCase()).not.toContain('formulas');
    expect(description).toContain('Use wb_draw_latex for mathematical equations');
  });
});
