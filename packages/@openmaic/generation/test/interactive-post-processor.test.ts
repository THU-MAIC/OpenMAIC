import { Script, createContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { postProcessInteractiveHtml } from '../src/interactive-post-processor.js';

describe('interactive HTML post-processing', () => {
  it('preserves a truncated script through EOF before KaTeX injection', () => {
    const source =
      '<script>const transform = `translate(${pos.x}, ${pos.y})`; const label = "$E$";';
    expect(postProcessInteractiveHtml(source).endsWith(source)).toBe(true);
  });

  it('does not match across template interpolation while converting inline math', () => {
    const source =
      '<div data-transform="translate(${pos.x}, ${pos.y})" data-price="cost $5 ${pos.x}" data-after="${pos.x}$x$">$\\frac{1}{2}$</div>';
    const processed = postProcessInteractiveHtml(source);
    expect(processed).toContain('translate(${pos.x}, ${pos.y})');
    expect(processed).toContain('cost $5 ${pos.x}');
    expect(processed).toContain('data-after="${pos.x}$x$"');
    expect(processed).toContain('\\(\\frac{1}{2}\\)');
  });

  it('still protects closed scripts and converts math after them', () => {
    const source = '<script>const label = "$E$";</script><p>$x$</p>';
    const processed = postProcessInteractiveHtml(source);
    expect(processed).toContain('const label = "$E$";');
    expect(processed).toContain('<p>\\(x\\)</p>');
  });
});

const PAGE_WITH_OWN_KATEX = [
  '<!DOCTYPE html>',
  '<html><head><meta charset="UTF-8">',
  '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">',
  '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>',
  '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>',
  '</head><body><div id="cards"></div>',
  '<script>',
  'document.addEventListener("DOMContentLoaded", function () {',
  '  renderMathInElement(document.body, { throwOnError: false });',
  '  katex.render("2^{-2}", document.getElementById("cards"));',
  '  window.pageInit = { observing: window.observing === true };',
  '});',
  '</script></body></html>',
].join('\n');

const INJECTED_SCRIPT = /<script data-openmaic-katex="2">([\s\S]*?)<\/script>/;
const PAGE_INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/;

/**
 * Run the page's inline scripts the way a browser would when every external
 * script fails to load (an unreachable CDN), then fire DOMContentLoaded.
 */
function runWithoutExternalScripts(html: string) {
  const listeners: Array<() => void> = [];
  const element = { textContent: '' };
  const context: Record<string, unknown> = {
    document: {
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'DOMContentLoaded') listeners.push(listener);
      },
      getElementById: () => element,
      body: { innerText: '' },
    },
    MutationObserver: class {
      observe() {
        context.observing = true;
      }
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  context.window = context;
  createContext(context);
  for (const pattern of [INJECTED_SCRIPT, PAGE_INLINE_SCRIPT]) {
    const source = pattern.exec(html)?.[1];
    if (source === undefined) throw new Error(`missing script ${pattern}`);
    new Script(source).runInContext(context);
  }
  for (const listener of listeners) listener();
  return { context, element };
}

describe('KaTeX injection', () => {
  it('injects the platform KaTeX ahead of a page that ships its own KaTeX tags', () => {
    const processed = postProcessInteractiveHtml(PAGE_WITH_OWN_KATEX);
    const injected = processed.indexOf('data-openmaic-katex');
    expect(injected).toBeGreaterThan(processed.indexOf('<head>'));
    expect(injected).toBeLessThan(processed.indexOf('<meta charset'));
    expect(processed.match(/<script data-openmaic-katex="2">/g) ?? []).toHaveLength(1);
    expect(processed).not.toContain('cdn.jsdelivr.net');
    expect(processed).toContain('/vendor/interactive/katex@0.16.38/dist/katex.min.js');
    expect(postProcessInteractiveHtml(processed)).toBe(processed);
  });

  it("keeps the page's own KaTeX calls from throwing when the CDN is unreachable", () => {
    const { context, element } = runWithoutExternalScripts(
      postProcessInteractiveHtml(PAGE_WITH_OWN_KATEX),
    );
    expect(context.pageInit).toBeDefined();
    expect(element.textContent).toBe('2^{-2}');
  });

  it('starts observing before the page fills its labels on DOMContentLoaded', () => {
    // The page handler records whether the observer was already installed.
    const { context } = runWithoutExternalScripts(postProcessInteractiveHtml(PAGE_WITH_OWN_KATEX));
    expect((context.pageInit as { observing: boolean }).observing).toBe(true);
  });

  it('leaves a page without math unchanged', () => {
    const source = '<html><head><title>Plain</title></head><body><p>No math</p></body></html>';
    expect(postProcessInteractiveHtml(source)).toBe(source);
  });

  it('places the injection in head for documents without an explicit head', () => {
    const withHtml = postProcessInteractiveHtml('<html><body>$x$</body></html>');
    expect(withHtml.startsWith('<html><head>\n<script data-openmaic-katex')).toBe(true);
    const withDoctype = postProcessInteractiveHtml('<!DOCTYPE html><p>$x$</p>');
    expect(withDoctype.startsWith('<!DOCTYPE html><head>\n<script data-openmaic-katex')).toBe(true);
  });

  it('ignores a head tag that only appears inside a comment', () => {
    const processed = postProcessInteractiveHtml(
      '<!-- <head> --><html><head><title>t</title></head><body>$x$</body></html>',
    );
    expect(processed.startsWith('<!-- <head> --><html><head>\n<script data-openmaic-katex')).toBe(
      true,
    );
  });
});
