// Run with node --import tsx and a Chromium executable configured.
//
// Renders a slide whose prose holds inline formulas in the stored form
// (`<span data-inline-math="SRC">SRC</span>`) through the real
// ChromiumPreviewRenderer, and inspects the page just before capture.
// Idle callbacks are disabled before the slide mounts, so every formula must
// be typeset synchronously at mount: the live renderer's per-pass budget
// (100 formulas) would leave some of these 150 to idle time.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { ChromiumPreviewRenderer } from '../src/preview-renderer.ts';

const stored = (latex) => {
  const escaped = latex.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<span data-inline-math="${escaped}">${escaped}</span>`;
};
const many = Array.from({ length: 148 }, (_, i) => stored(`x_{${i}}`)).join(' ');
const content = `<p>Energy ${stored('E=mc^2')} and ${stored('\\frac{a}{b}')}.</p><p>${many}</p>`;

const scene = {
  id: 'inline-math-scene',
  stageId: 'stage',
  order: 1,
  title: 'Inline math',
  type: 'slide',
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#fff',
        themeColors: [],
        fontColor: '#111',
        fontName: 'sans-serif',
      },
      elements: [
        {
          id: 'text-1',
          type: 'text',
          left: 40,
          top: 40,
          width: 900,
          height: 400,
          rotate: 0,
          content,
          defaultFontName: 'sans-serif',
          defaultColor: '#111',
        },
      ],
    },
  },
  actions: [],
};

let state;
const browserLauncher = {
  async launch(options) {
    const browser = await puppeteer.launch(options);
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async () => {
      const page = await newPage();
      const addScriptTag = page.addScriptTag.bind(page);
      page.addScriptTag = async (tag) => {
        await page.evaluate(() => {
          window.requestIdleCallback = () => 0;
          window.cancelIdleCallback = () => {};
        });
        return addScriptTag(tag);
      };
      const screenshot = page.screenshot.bind(page);
      page.screenshot = async (shotOptions) => {
        state = await page.evaluate(() => {
          const formulas = [...document.querySelectorAll('#preview-slide-root [data-inline-math]')];
          const variable = document.querySelector('#preview-slide-root .katex .mathnormal');
          return {
            formulas: formulas.length,
            typeset: formulas.filter((formula) => formula.classList.contains('katex')).length,
            fractions: document.querySelectorAll('#preview-slide-root .katex .mfrac').length,
            variableFont: variable ? getComputedStyle(variable).fontFamily : null,
            mathFontLoaded: [...document.fonts].some(
              (face) => face.family === 'KaTeX_Math' && face.status === 'loaded',
            ),
          };
        });
        return screenshot(shotOptions);
      };
      return page;
    };
    return browser;
  },
};

const png = Buffer.from(
  await new ChromiumPreviewRenderer({ browserLauncher }).render({
    scene,
    stage: { id: 'stage', name: 'Course' },
    viewport: { width: 1000, height: 562, deviceScaleFactor: 1 },
    signal: AbortSignal.timeout(30_000),
    deadlineMs: 30_000,
  }),
);
assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.deepEqual(state, {
  formulas: 150,
  typeset: 150,
  fractions: 1,
  variableFont: 'KaTeX_Math',
  mathFontLoaded: true,
});
console.log('inline math typeset');
