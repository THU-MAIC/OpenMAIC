import { describe, expect, it } from 'vitest';
import { parseActionsFromStructuredOutput, postProcessInteractiveHtml } from '@openmaic/generation';

describe('action parser', () => {
  it('repairs malformed structured output and preserves interleaving', () => {
    const actions = parseActionsFromStructuredOutput(
      '[{"type":"text","content":"Start"},{"type":"action","name":"widget_setState","params":{}}',
      'interactive',
      ['widget_setState'],
    );
    expect(actions).toEqual([
      expect.objectContaining({ type: 'speech', text: 'Start' }),
      expect.objectContaining({ type: 'widget_setState', state: {} }),
    ]);
  });

  it('filters slide-only actions from non-slide scenes', () => {
    expect(
      parseActionsFromStructuredOutput(
        '[{"type":"action","name":"spotlight","params":{"elementId":"x"}}]',
        'quiz',
      ),
    ).toEqual([]);
  });
});

describe('interactive HTML post-processing', () => {
  it('converts math, protects scripts, and injects KaTeX once', () => {
    const source =
      '<html><head></head><body>$x+1$<script>const price = "$5";</script></body></html>';
    const once = postProcessInteractiveHtml(source);
    const twice = postProcessInteractiveHtml(once);
    expect(once).toContain('\\(x+1\\)');
    expect(once).toContain('const price = "$5";');
    expect(once).toContain('katex.min.css');
    expect(twice.match(/katex\.min\.css/g) ?? []).toHaveLength(1);
  });

  it("adds auto-render + observer after the page's own KaTeX core instead of skipping", () => {
    const source =
      '<html><head>' +
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">' +
      '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>' +
      '</head><body><label>\\(2^{-2}\\)</label></body></html>';
    const out = postProcessInteractiveHtml(source);
    expect(out.match(/contrib\/auto-render\.min\.js/g) ?? []).toHaveLength(1);
    expect(out).toContain('renderMathInElement(document.body');
    // Core is not duplicated, and the contrib lands after the page's own core.
    expect(out.match(/dist\/katex\.min\.js/g) ?? []).toHaveLength(1);
    expect(out.match(/katex\.min\.css/g) ?? []).toHaveLength(1);
    expect(out.indexOf('auto-render.min.js')).toBeGreaterThan(out.indexOf('<body>'));
    expect(out.indexOf('auto-render.min.js')).toBeLessThan(out.indexOf('</body>'));
    expect(postProcessInteractiveHtml(out)).toBe(out);
    const observerIdx = out.indexOf('observer.observe(document.body');
    expect(observerIdx).toBeGreaterThan(-1);
    expect(out.indexOf('setTimeout(safeRender, 300)')).toBeGreaterThan(observerIdx);
    expect(out.indexOf('addEventListener("load"')).toBeGreaterThan(observerIdx);
  });

  it('leaves a page alone when it already wires auto-render', () => {
    const source =
      '<html><head><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>' +
      '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>' +
      '</head><body>\\(a\\)</body></html>';
    expect(postProcessInteractiveHtml(source)).toBe(source);
  });

  it('leaves a page alone when it already calls renderMathInElement', () => {
    const source =
      '<html><head><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>' +
      '</head><body>\\(a\\)<script>renderMathInElement(document.body)</script></body></html>';
    expect(postProcessInteractiveHtml(source)).toBe(source);
  });

  it('schedules post-observer safeRender passes after init()-filled labels', () => {
    const out = postProcessInteractiveHtml('<html><head></head><body>$x$</body></html>');
    const observerIdx = out.indexOf('observer.observe(document.body');
    expect(observerIdx).toBeGreaterThan(-1);
    expect(out.indexOf('setTimeout(safeRender, 300)')).toBeGreaterThan(observerIdx);
    expect(out.indexOf('addEventListener("load"')).toBeGreaterThan(observerIdx);
  });
});
