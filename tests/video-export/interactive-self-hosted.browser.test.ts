/** Chromium proof of local-library classroom, standalone, and video math rendering. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { postProcessInteractiveHtml, interactiveLibraryUrl } from '@openmaic/generation/browser';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import { inlineSceneContent } from '@/lib/export/use-export-classroom';
import { prepareInteractiveHtmlScenes } from '@/lib/video-export-app/prepare-interactive-html';
import type { Scene } from '@/lib/types/stage';
import type { FetchAsset } from '@/lib/export/inline-assets';

const ORIGIN = 'http://classroom.test';
const REQUIRED = process.env.INTERACTIVE_STATIC_BROWSER === '1';
const math =
  '<!doctype html><html><head></head><body><p id="formula">$2+2=4$</p><script>window.parserReachedBody = true;</script></body></html>';
const fetchAsset: FetchAsset = async (url) => {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN || !parsed.pathname.startsWith('/vendor/interactive/'))
    throw new Error(`Unexpected external request: ${url}`);
  const bytes = new Uint8Array(await readFile(join(process.cwd(), 'public', parsed.pathname)));
  return {
    bytes,
    contentType: url.endsWith('.css')
      ? 'text/css'
      : url.endsWith('.js')
        ? 'text/javascript'
        : 'font/woff2',
  };
};

describe.skipIf(!REQUIRED)('self-hosted interactive libraries in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--disable-crash-reporter', '--disable-crashpad'],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** Serves `html` at ORIGIN, extra routes by URL, and hosted libraries from public/. */
  async function openPage(
    html: string,
    extra: Record<string, string> = {},
    options: { failLibraries?: boolean } = {},
  ) {
    const page = await browser.newPage();
    const requests: string[] = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      requests.push(url);
      if (url === `${ORIGIN}/`) return route.fulfill({ contentType: 'text/html', body: html });
      if (url in extra) return route.fulfill({ contentType: 'text/javascript', body: extra[url]! });
      if (options.failLibraries) return route.abort();
      const asset = await fetchAsset(url);
      await route.fulfill({
        body: Buffer.from(asset!.bytes),
        contentType: asset!.contentType,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    });
    await page.goto(ORIGIN);
    return { page, requests };
  }

  const parseTimeRender =
    "document.getElementById('formula').innerHTML = katex.renderToString('x^2');";

  it('typesets in a sandboxed classroom iframe using local requests only', async () => {
    const { page, requests } = await openPage(
      `<iframe sandbox="allow-scripts" srcdoc="${patchHtmlForIframe(math).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`,
    );
    try {
      const frame = page.frames().find((frame) => frame !== page.mainFrame())!;
      await expect.poll(() => frame.locator('.katex').count()).toBe(1);
      expect(requests.every((url) => url.startsWith(ORIGIN))).toBe(true);
      expect(requests.some((url) => url.endsWith('.woff2'))).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('keeps parsing and page initialization working when local libraries fail', async () => {
    const { page } = await openPage(
      postProcessInteractiveHtml(
        math.replace(
          'window.parserReachedBody = true;',
          "katex.render('x', document.getElementById('formula')); window.parserReachedBody = true;",
        ),
      ),
      {},
      { failLibraries: true },
    );
    try {
      expect(
        await page.evaluate(
          () => (window as unknown as { parserReachedBody: boolean }).parserReachedBody,
        ),
      ).toBe(true);
      expect(await page.locator('#formula').textContent()).toBe('x');
    } finally {
      await page.close();
    }
  });

  it.each([
    [
      'an inline katex.render call',
      `<script>katex.render('x^2', document.getElementById('formula'));</script>`,
      {},
    ],
    ['an inline katex.renderToString call', `<script>${parseTimeRender}</script>`, {}],
    [
      'a blocking external script',
      '<script src="/app.js"></script>',
      { [`${ORIGIN}/app.js`]: parseTimeRender },
    ],
    [
      'an async external script',
      '<script async src="/app.js"></script>',
      { [`${ORIGIN}/app.js`]: parseTimeRender },
    ],
    [
      'a String.raw template',
      '<script>document.getElementById("formula").textContent = String.raw`\\(\\frac{1}{2}\\)`;</script>',
      {},
    ],
  ])('typesets math rendered during parsing by %s', async (_name, script, extra) => {
    const { page } = await openPage(
      postProcessInteractiveHtml(
        `<!doctype html><html><head></head><body><p>$y$</p><p id="formula"></p>${script}</body></html>`,
      ),
      extra,
    );
    try {
      await expect.poll(() => page.locator('#formula .katex').count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('applies authored auto-render options from a parse-time renderMathInElement call', async () => {
    const { page } = await openPage(
      postProcessInteractiveHtml(
        `<!doctype html><html><head></head><body><p id="formula">@@x^2@@</p><script>renderMathInElement(document.body, { delimiters: [{ left: '@@', right: '@@', display: false }] });</script></body></html>`,
      ),
    );
    try {
      expect(await page.locator('#formula .katex').count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('makes no library request for a page without math', async () => {
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    try {
      await page.setContent(postProcessInteractiveHtml('<p>Price: $5 and $10</p>'));
      expect(requests).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('loads Three.js and OrbitControls modules from the deployment', async () => {
    const page = await browser.newPage();
    const html = `<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}</script><script type="module">import {Vector3} from 'three'; import {OrbitControls} from 'three/addons/controls/OrbitControls.js'; document.body.textContent = typeof OrbitControls + new Vector3(1,2,3).lengthSq();</script>`;
    const requests: string[] = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      requests.push(url);
      if (url === `${ORIGIN}/`)
        return route.fulfill({ contentType: 'text/html', body: postProcessInteractiveHtml(html) });
      const asset = await fetchAsset(url);
      await route.fulfill({
        body: Buffer.from(asset!.bytes),
        contentType: asset!.contentType,
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    });
    try {
      await page.goto(ORIGIN);
      await expect.poll(() => page.locator('body').textContent()).toBe('function14');
      expect(requests.every((url) => url.startsWith(ORIGIN))).toBe(true);
      expect(requests.some((url) => url.endsWith('/controls/OrbitControls.js'))).toBe(true);
    } finally {
      await page.close();
    }
  });

  it.each(['standalone', 'video'])(
    'typesets offline in %s HTML with scripts, CSS, and fonts embedded',
    async (kind) => {
      let html: string;
      if (kind === 'standalone') {
        const result = await inlineSceneContent(
          { type: 'interactive', url: '', html: math },
          { fetcher: fetchAsset, baseUrl: ORIGIN },
        );
        expect(result.report.failed).toEqual([]);
        html = (result.content as { html: string }).html;
      } else {
        const scene = {
          id: 'math',
          type: 'interactive',
          content: { type: 'interactive', url: '', html: math },
          actions: [],
        } as unknown as Scene;
        const prepared = await prepareInteractiveHtmlScenes([scene], {
          fetcher: fetchAsset,
          baseUrl: ORIGIN,
        });
        expect(prepared.html(scene)?.present).toBe(true);
        html = prepared.content('interactive:math')!;
      }
      expect(html).not.toContain(`src="${ORIGIN}`);
      expect(html).not.toContain(`href="${ORIGIN}`);
      expect(html).toContain('data:font/woff2;base64,');
      const page = await browser.newPage();
      const requests: string[] = [];
      await page.route('**/*', (route) => {
        requests.push(route.request().url());
        return route.abort();
      });
      try {
        await page.setContent(html);
        await expect.poll(() => page.locator('.katex').count()).toBe(1);
        expect(
          await page.locator('.katex').evaluate((element) => getComputedStyle(element).fontFamily),
        ).toContain('KaTeX');
        expect(requests.filter((url) => /^https?:/.test(url))).toEqual([]);
        if (kind === 'video')
          await expect
            .poll(() => page.locator('html').getAttribute('data-openmaic-static-state'))
            .toBe('frozen');
      } finally {
        await page.close();
      }
    },
  );

  it('executes the hosted Tailwind and Chart browser runtimes', async () => {
    const page = await browser.newPage();
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`)
        return route.fulfill({
          contentType: 'text/html',
          body: `<script src="${interactiveLibraryUrl('@tailwindcss/browser')}"></script><script src="${interactiveLibraryUrl('chart.js')}"></script><h1 class="text-4xl">Chart</h1>`,
        });
      const asset = await fetchAsset(url);
      await route.fulfill({ body: Buffer.from(asset!.bytes), contentType: asset!.contentType });
    });
    try {
      await page.goto(ORIGIN);
      expect(
        await page.evaluate(
          () => (window as unknown as { Chart: { version: string } }).Chart.version,
        ),
      ).toBe('4.4.8');
      await expect
        .poll(() => page.locator('h1').evaluate((element) => getComputedStyle(element).fontSize))
        .toBe('36px');
    } finally {
      await page.close();
    }
  });
});
