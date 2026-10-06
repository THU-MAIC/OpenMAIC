// @vitest-environment jsdom
import katex from 'katex';
import { describe, expect, it } from 'vitest';

import { sanitizeProseHtml, sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import {
  createTextDocument,
  serializeTextDocument,
} from '../../packages/@openmaic/editor/src/react/text/prosemirror/document';

function fragment(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function sourceHtml(latex: string): string {
  const span = document.createElement('span');
  span.setAttribute('data-inline-math', latex);
  return span.outerHTML;
}

describe('inline math at the persistence boundary', () => {
  it.each([String.raw`\sqrt{x}`, String.raw`\frac{a}{b}`])(
    'keeps editor source and formula layout through saves and reopens: %s',
    (latex) => {
      const doc = createTextDocument(`<p>Before ${katex.renderToString(latex)} after</p>`);
      const html = serializeTextDocument(doc);
      const payload = {
        elements: [
          { type: 'text', content: html },
          { type: 'shape', text: { content: html } },
          { type: 'table', data: [[{ text: html }]] },
        ],
      };
      const saved = sanitizeSceneContent(payload);
      const [text, shape, table] = saved.elements;
      for (const content of [text.content!, shape.text!.content, table.data![0][0].text]) {
        const root = fragment(content);
        expect(root.querySelector('[data-inline-math]')?.getAttribute('data-inline-math')).toBe(
          latex,
        );
        expect(root.querySelectorAll('.katex')).toHaveLength(1);
        expect(root.querySelector('.katex-html')).not.toBeNull();
        expect(root.querySelector('annotation, math')).toBeNull();
        expect(root.querySelector('[style*="top:"]')).not.toBeNull();
        if (latex.includes('sqrt')) {
          expect(root.querySelector('svg path')?.getAttribute('d')).toBeTruthy();
          expect(root.querySelector('svg')?.getAttribute('viewBox')).toBeTruthy();
        } else {
          expect(root.querySelector('.frac-line')).not.toBeNull();
        }
        expect(createTextDocument(content).eq(doc)).toBe(true);
        expect(sanitizeProseHtml(serializeTextDocument(createTextDocument(content)))).toBe(content);
      }
      expect(sanitizeSceneContent(saved)).toEqual(saved);
      expect(payload.elements[0].content).toBe(html);
    },
  );

  it('recovers source from imported KaTeX annotations when no source attribute exists', () => {
    const latex = String.raw`\sqrt{\frac{x}{2}}`;
    const result = sanitizeProseHtml(`<p>${katex.renderToString(latex)}</p>`);
    expect(
      fragment(result).querySelector('[data-inline-math]')?.getAttribute('data-inline-math'),
    ).toBe(latex);
    expect(createTextDocument(result).firstChild!.firstChild!.attrs.latex).toBe(latex);
    expect(sanitizeProseHtml(result)).toBe(result);
  });

  it.each(['', '   ', String.raw`\notacommand{`, String.raw`x < y & " ' $& $$ $1`])(
    'round-trips literal, empty or invalid source without creating markup: %j',
    (latex) => {
      const result = sanitizeProseHtml(`<p>A${sourceHtml(latex)}B</p>`);
      const doc = createTextDocument(result);
      expect(doc.firstChild!.child(1).type.name).toBe('inline_math');
      expect(doc.firstChild!.child(1).attrs.latex).toBe(latex);
      expect(doc.firstChild!.firstChild!.text).toBe('A');
      expect(doc.firstChild!.lastChild!.text).toBe('B');
      expect(sanitizeProseHtml(result)).toBe(result);
    },
  );

  it('prefers the source attribute, discarding all authored formula markup', () => {
    const html = `<p><span class="katex forged" data-inline-math="x" onclick="alert(1)" style="position:fixed;color:red">
      <math><annotation encoding="application/x-tex">wrong</annotation></math>
      <span data-inline-math="wrong">nested</span><img src=x onerror="alert(1)">
      <svg onload="alert(1)"><path d="forged"></path></svg><script>alert(1)</script>
      forged text</span><span style="position:fixed;top:0;color:blue" onclick="alert(1)">prose</span></p>`;
    const result = sanitizeProseHtml(html);
    const root = fragment(result);
    expect(root.querySelectorAll('[data-inline-math]')).toHaveLength(1);
    expect(root.querySelector('[data-inline-math]')?.getAttribute('data-inline-math')).toBe('x');
    expect(result).not.toMatch(
      /wrong|forged|nested|onclick|onerror|onload|<script|<img|<svg|position:fixed|top:0|color:red/,
    );
    expect(result).toContain('color:blue');
    expect(root.textContent).toBe('xprose');
  });

  it('does not trust LaTeX commands that insert URLs or HTML attributes', () => {
    const latex = String.raw`\href{javascript:alert(1)}{x}\includegraphics{https://example.com/x}\htmlStyle{position:fixed}{x}`;
    const root = fragment(sanitizeProseHtml(sourceHtml(latex)));
    expect(root.querySelector('a, img, [style*="position:fixed"]')).toBeNull();
    expect(root.querySelector('[data-inline-math]')?.getAttribute('data-inline-math')).toBe(latex);
  });

  it('does not treat a KaTeX class alone as trusted formula output', () => {
    const result = sanitizeProseHtml(
      '<span class="katex"><svg><path d="fake"/></svg><span style="position:fixed;top:0">x</span></span>',
    );
    expect(result).not.toMatch(/<svg|<path|position:|top:/);
    expect(fragment(result).querySelector('[data-inline-math]')).toBeNull();
  });

  it('preserves separate formulas and source inside template contents exposed by sanitization', () => {
    const result = sanitizeProseHtml(
      `<p>${sourceHtml('x')}${sourceHtml('y')}</p><template>${katex.renderToString(String.raw`\sqrt{z}`)}</template>`,
    );
    const root = fragment(result);
    expect(
      [...root.querySelectorAll('[data-inline-math]')].map((el) =>
        el.getAttribute('data-inline-math'),
      ),
    ).toEqual(['x', 'y', String.raw`\sqrt{z}`]);
    expect(root.querySelectorAll('.katex')).toHaveLength(3);
    expect(sanitizeProseHtml(result)).toBe(result);
  });
});
