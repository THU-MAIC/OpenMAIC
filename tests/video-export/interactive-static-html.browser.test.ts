/** Isolated Chromium proof for packaged interactive HTML readiness, freeze, and fallback. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { compileVideoTimeline, emitHyperframes } from '@/lib/video-export';
import { prepareInteractiveHtmlScenes } from '@/lib/video-export-app/prepare-interactive-html';
import type { Scene } from '@/lib/types/stage';
import { NO_ASSETS, NO_PROBE } from './helpers';

const REQUIRED = process.env.INTERACTIVE_STATIC_BROWSER === '1';
const BASE_URL = 'http://interactive-static.test';
const GSAP = readFileSync(join(process.cwd(), 'public/vendor/gsap.min.js'), 'utf8');

function interactiveScene(html: string): Scene {
  return {
    id: 'widget',
    stageId: 'stage',
    title: 'Static interactive fixture',
    order: 0,
    type: 'interactive',
    content: { type: 'interactive', url: '', html },
    actions: [],
  } as Scene;
}

async function emittedFixture(html: string): Promise<{ index: string; child: string }> {
  const scene = interactiveScene(html);
  const prepared = await prepareInteractiveHtmlScenes([scene]);
  const ir = compileVideoTimeline(
    { stage: { id: 'stage', name: 'Interactive smoke' }, scenes: [scene] },
    { timing: NO_PROBE, assets: NO_ASSETS, interactive: prepared },
  );
  const project = emitHyperframes(ir, { width: 1280, height: 720 });
  return {
    index: project.files.find((file) => file.path === 'index.html')!.content,
    child: prepared.content('interactive:widget')!,
  };
}

async function load(page: Page, fixture: { index: string; child: string }): Promise<void> {
  await page.route(`${BASE_URL}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/index.html' || path === '/') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: fixture.index });
    } else if (path === '/assets/vendor/gsap.min.js') {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: GSAP });
    } else if (path === '/assets/interactive/001-static-interactive-fixture.html') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: fixture.child });
    } else {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
  await page.goto(`${BASE_URL}/index.html`, { waitUntil: 'load' });
}

describe.skipIf(!REQUIRED)('frozen interactive HTML in Chromium', () => {
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

  it('freezes the settled initial state before exposing the Hyperframes timeline', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await load(
        page,
        await emittedFixture(`<!doctype html><html><head>
          <style>#box{width:120px;height:120px;background:#6d28d9;animation:pulse .1s infinite alternate}@keyframes pulse{to{transform:scale(1.2)}}</style>
        </head><body><div id="box"></div><output id="counter">0</output><output id="worker-status">pending</output><script>
          var count=0; setInterval(function(){ document.getElementById('counter').textContent=String(++count); },20);
          try {
            new Worker(URL.createObjectURL(new Blob(['setInterval(function(){postMessage("tick")},20)'])));
          } catch (error) {
            document.getElementById('worker-status').textContent = error && error.message || String(error);
          }
        </script></body></html>`),
      );

      await page.waitForFunction(() => {
        const host = document.querySelector('[data-interactive-static-host]');
        const timelines = (window as typeof window & { __timelines?: Record<string, unknown> })
          .__timelines;
        return (
          host?.getAttribute('data-interactive-static-state') === 'frozen' && !!timelines?.openmaic
        );
      });

      const child = page.frames().find((frame) => frame !== page.mainFrame())!;
      const before = await child.evaluate(() => ({
        counter: document.querySelector('#counter')?.textContent,
        workerStatus: document.querySelector('#worker-status')?.textContent,
        state: document.documentElement.getAttribute('data-openmaic-static-state'),
        animations: document.getAnimations().map((animation) => animation.playState),
      }));
      await page.waitForTimeout(350);
      const after = await child.evaluate(() => ({
        counter: document.querySelector('#counter')?.textContent,
        workerStatus: document.querySelector('#worker-status')?.textContent,
        state: document.documentElement.getAttribute('data-openmaic-static-state'),
        animations: document.getAnimations().map((animation) => animation.playState),
      }));

      expect(before.state).toBe('frozen');
      expect(before.workerStatus).toContain('interactive-worker-disabled');
      expect(after).toEqual(before);
      expect(after.animations.every((state) => state === 'paused')).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('creates a standards-mode head without corrupting head-like script text', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await load(
        page,
        await emittedFixture(
          '<!doctype html><html><body><script>window.__template = "<head>";</script><main id="mode">Standards mode</main></body></html>',
        ),
      );
      await page.waitForFunction(() => {
        return (
          document
            .querySelector('[data-interactive-static-host]')
            ?.getAttribute('data-interactive-static-state') === 'frozen'
        );
      });

      const child = page.frames().find((frame) => frame !== page.mainFrame())!;
      expect(await child.evaluate(() => document.compatMode)).toBe('CSS1Compat');
      expect(
        await child.evaluate(() => (window as typeof window & { __template?: string }).__template),
      ).toBe('<head>');
    } finally {
      await page.close();
    }
  });

  it('switches a runtime failure to the visible placeholder without failing the composition', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await load(
        page,
        await emittedFixture(
          '<!doctype html><html><head></head><body><h1>Broken</h1><script>throw new Error("fixture boom")</script></body></html>',
        ),
      );

      await page.waitForFunction(() => {
        const host = document.querySelector('[data-interactive-static-host]');
        const timelines = (window as typeof window & { __timelines?: Record<string, unknown> })
          .__timelines;
        return (
          host?.getAttribute('data-interactive-static-state') === 'fallback' &&
          !!timelines?.openmaic
        );
      });

      const result = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('[data-interactive-static-host]')!;
        const fallback = host.querySelector<HTMLElement>('[data-interactive-fallback]')!;
        const diagnostics = (
          window as typeof window & {
            __openmaicVideoDiagnostics?: Array<{ code: string; message: string }>;
          }
        ).__openmaicVideoDiagnostics;
        const manifest = (
          window as typeof window & {
            __openmaicVideoManifest?: { runtimeDiagnostics?: Array<{ code: string }> };
          }
        ).__openmaicVideoManifest;
        const runtimeReport = document.querySelector<HTMLElement>(
          '[data-openmaic-runtime-diagnostics]',
        );
        return {
          state: host.getAttribute('data-interactive-static-state'),
          code: host.getAttribute('data-interactive-diagnostic'),
          fallbackDisplay: getComputedStyle(fallback).display,
          fallbackText: fallback.textContent,
          diagnostics,
          manifestDiagnostics: manifest?.runtimeDiagnostics,
          runtimeReport: runtimeReport?.textContent,
        };
      });

      expect(result).toMatchObject({
        state: 'fallback',
        code: 'interactive-runtime-failure',
        fallbackDisplay: 'block',
        fallbackText: expect.stringContaining('fixture boom'),
        diagnostics: [
          expect.objectContaining({
            code: 'interactive-runtime-failure',
            message: expect.stringContaining('fixture boom'),
          }),
        ],
        manifestDiagnostics: [expect.objectContaining({ code: 'interactive-runtime-failure' })],
        runtimeReport: expect.stringContaining('interactive-runtime-failure'),
      });
      expect(page.frames()).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('unloads the child document after a readiness failure', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await load(
        page,
        await emittedFixture(
          '<!doctype html><html><body><img src="data:image/png;base64,AAAA"><script>setInterval(function(){ window.__ticks = (window.__ticks || 0) + 1; }, 10)</script></body></html>',
        ),
      );

      await page.waitForFunction(() => {
        return (
          document
            .querySelector('[data-interactive-static-host]')
            ?.getAttribute('data-interactive-static-state') === 'fallback'
        );
      });
      await page.waitForTimeout(100);

      expect(page.frames()).toHaveLength(1);
      expect(
        await page
          .locator('[data-interactive-static-host]')
          .getAttribute('data-interactive-diagnostic'),
      ).toBe('interactive-ready-failure');
    } finally {
      await page.close();
    }
  });
});
