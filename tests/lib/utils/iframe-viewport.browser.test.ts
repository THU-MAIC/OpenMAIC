/** Chromium regression proof for the generated-document root scroll contract. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

const REQUIRED = process.env.INTERACTIVE_VIEWPORT_BROWSER === '1';

describe.skipIf(!REQUIRED)('interactive iframe viewport in Chromium', () => {
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

  it('keeps the viewport fixed and delegates tall generated content to body only', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await page.setContent(
        patchHtmlForIframe(`<!doctype html><html><head>
          <style>
            html, body { min-height: 100vh; overflow-y: auto; }
            #generated-chart { height: 5000px; }
          </style>
        </head><body><main id="generated-chart">chart</main></body></html>`),
      );

      const before = await page.evaluate(() => ({
        viewportHeight: window.innerHeight,
        htmlClientHeight: document.documentElement.clientHeight,
        bodyClientHeight: document.body.clientHeight,
        bodyScrollHeight: document.body.scrollHeight,
        htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
        bodyOverflowY: getComputedStyle(document.body).overflowY,
      }));
      await page.evaluate(() => {
        document.body.scrollTop = 900;
      });
      const after = await page.evaluate(() => ({
        htmlScrollTop: document.documentElement.scrollTop,
        bodyScrollTop: document.body.scrollTop,
        viewportHeight: window.innerHeight,
      }));

      expect(before).toMatchObject({
        viewportHeight: 720,
        htmlClientHeight: 720,
        bodyClientHeight: 720,
        htmlOverflowY: 'hidden',
        bodyOverflowY: 'auto',
      });
      expect(before.bodyScrollHeight).toBeGreaterThan(720);
      expect(after).toEqual({ htmlScrollTop: 0, bodyScrollTop: 900, viewportHeight: 720 });
    } finally {
      await page.close();
    }
  });
});
