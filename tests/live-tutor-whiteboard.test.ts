import { describe, expect, it } from 'vitest';
import {
  applyWhiteboardOps,
  buildWhiteboardFromSteps,
  renderSafeLatexHtml,
} from '@/lib/live-tutor/whiteboard-elements';

describe('live-tutor whiteboard projection', () => {
  it('applies heading, step, formula, and clear operations in order', () => {
    const first = applyWhiteboardOps(
      [],
      [
        { op: 'add_heading', content: 'Quadratic Equations' },
        { op: 'add_step', content: 'Subtract 5 from both sides' },
        { op: 'add_formula', content: 'x^2 + 4x = 12' },
      ],
    );

    expect(first).toHaveLength(3);
    expect(first[0].kind).toBe('heading');
    expect(first[1].kind).toBe('text');
    expect(first[2].kind).toBe('latex');

    const cleared = applyWhiteboardOps(first, [
      { op: 'clear' },
      { op: 'add_step', content: 'Fresh step' },
    ]);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].content).toBe('Fresh step');
  });

  it('builds a valid @openmaic/dsl Whiteboard with non-overlapping text and latex elements', () => {
    const steps = applyWhiteboardOps(
      [],
      [
        { op: 'add_heading', content: 'Pythagorean Theorem' },
        { op: 'add_formula', content: 'a^2 + b^2 = c^2' },
        { op: 'add_step', content: 'Substitute a = 3 and b = 4 into the equation.' },
      ],
    );

    const wb = buildWhiteboardFromSteps(steps, 'wb-test-1');
    expect(wb.id).toBe('wb-test-1');
    expect(wb.viewportSize).toBe(1000);
    expect(wb.elements).toHaveLength(3);
    expect(wb.elements[0].type).toBe('text');
    expect(wb.elements[1].type).toBe('latex');
    expect(wb.elements[2].type).toBe('text');
    expect(wb.elements[1].top).toBeGreaterThan(wb.elements[0].top);
    expect(wb.elements[2].top).toBeGreaterThan(wb.elements[1].top);
  });

  it('renders safe KaTeX HTML and escapes unsafe raw text', () => {
    const katexHtml = renderSafeLatexHtml('\\frac{1}{2}', false);
    expect(katexHtml).toContain('katex');

    const steps = applyWhiteboardOps([], [{ op: 'add_step', content: 'Check x < 5 & y > 2' }]);
    const wb = buildWhiteboardFromSteps(steps);
    const firstEl = wb.elements[0];
    expect(firstEl.type).toBe('text');
    if (firstEl.type === 'text') {
      expect(firstEl.content).toContain('&lt;');
      expect(firstEl.content).toContain('&amp;');
    }
  });
});
