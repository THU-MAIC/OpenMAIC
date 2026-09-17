import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTxBodyHtml } from './helpers';

const wideTextParagraph = `<a:p><a:pPr><a:tabLst><a:tab pos="952500"/><a:tab pos="1905000"/></a:tabLst></a:pPr><a:r><a:rPr sz="1200"><a:latin typeface="Arial"/></a:rPr><a:t>WWWWWWWW\tNext</a:t></a:r></a:p>`;

afterEach(() => vi.unstubAllGlobals());

describe('custom tab columns without font metrics', () => {
  it('lets underestimated wide text expand its column instead of overlapping the next text', () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const html = renderTxBodyHtml(wideTextParagraph);
    // Eight Arial W glyphs need about 121px; the server estimate is only 64px.
    expect(html).toMatch(/display:inline-block;width:75\.00pt;[^"\n]*min-width:max-content;/);
  });

  it('also protects columns when the canvas cannot provide a context', () => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return null;
        }
      },
    );
    expect(renderTxBodyHtml(wideTextParagraph)).toContain('min-width:max-content;');
  });

  it('keeps accurately measured browser columns fixed', () => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { measureText: () => ({ width: 121 }) };
        }
      },
    );
    const html = renderTxBodyHtml(wideTextParagraph);
    expect(html).toContain('width:150.00pt;');
    expect(html).not.toContain('min-width:');
  });
});
