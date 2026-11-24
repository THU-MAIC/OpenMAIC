/** Isolated Chromium proof for packaged interactive HTML readiness, freeze, and fallback. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { compileVideoTimeline, emitHyperframes } from '@/lib/video-export';
import { prepareInteractiveHtmlScenes } from '@/lib/video-export-app/prepare-interactive-html';
import type { FetchAsset } from '@/lib/export/inline-assets-shared';
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

async function emittedFixture(
  html: string,
  fetcher?: FetchAsset,
): Promise<{ index: string; child: string }> {
  const scene = interactiveScene(html);
  const prepared = await prepareInteractiveHtmlScenes([scene], { fetcher });
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

  it('draws a queued initial canvas frame when the renderer suspends animation frames', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await page.addInitScript(() => {
        if (window.parent === window) return;
        let id = 0;
        window.requestAnimationFrame = () => ++id;
        window.cancelAnimationFrame = () => {};
      });
      await load(
        page,
        await emittedFixture(`
          <canvas width="10" height="10"></canvas>
          <script>
            const canvas = document.querySelector('canvas');
            const context = canvas.getContext('2d');
            function frame() {
              context.fillStyle = 'red';
              context.fillRect(0, 0, 10, 10);
              requestAnimationFrame(frame);
            }
            requestAnimationFrame(frame);
          </script>`),
      );

      await page.waitForFunction(() => {
        const host = document.querySelector('[data-interactive-static-host]');
        return host?.getAttribute('data-interactive-static-state') === 'frozen';
      });
      const child = page.frames().find((frame) => frame !== page.mainFrame())!;
      const pixel = await child.evaluate(() => [
        ...document.querySelector('canvas')!.getContext('2d')!.getImageData(0, 0, 1, 1).data,
      ]);

      expect(pixel).toEqual([255, 0, 0, 255]);
    } finally {
      await page.close();
    }
  });

  it('waits for a runtime started during the scene settling window', async () => {
    const page = await browser.newPage();
    try {
      await load(
        page,
        await emittedFixture(`
          <output>Loading</output>
          <script>
            window.addEventListener('load', () => {
              setTimeout(() => {
                const ready = new Promise((resolve) => setTimeout(resolve, 400));
                window.__openmaicWaitForStaticRuntime(ready).then(() => setTimeout(() => {
                  document.querySelector('output').textContent = 'Ready';
                }, 0));
              }, 100);
            });
          </script>`),
      );

      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-interactive-static-host]')
            ?.getAttribute('data-interactive-static-state') === 'frozen',
      );
      const child = page.frames().find((frame) => frame !== page.mainFrame())!;
      expect(await child.locator('output').textContent()).toBe('Ready');
    } finally {
      await page.close();
    }
  });

  it('runs an authored Pyodide load handler and serves its explicit core URL offline', async () => {
    const page = await browser.newPage();
    try {
      const root = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';
      await load(
        page,
        await emittedFixture(
          `<script defer src="${root}pyodide.js"
             onload="loadPyodide({lockFileURL: '${root}pyodide-lock.json'}).then((value) => { document.querySelector('output').textContent = value; })">
           </script><output>Loading</output>`,
          async (url) => ({
            bytes: new TextEncoder().encode(
              url.endsWith('/pyodide.js')
                ? 'globalThis.loadPyodide = async (options) => (await fetch(options.lockFileURL)).text();'
                : '42',
            ),
            contentType: 'text/javascript',
          }),
        ),
      );

      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-interactive-static-host]')
            ?.getAttribute('data-interactive-static-state') === 'frozen',
      );
      const child = page.frames().find((frame) => frame !== page.mainFrame())!;
      expect(await child.locator('output').textContent()).toBe('42');
    } finally {
      await page.close();
    }
  });

  it.each([
    { distribution: 'full', missingAtStartup: 'unused' },
    { distribution: 'npm', missingAtStartup: 'unused' },
    { distribution: 'full', missingAtStartup: 'unhandled' },
    { distribution: 'full', missingAtStartup: 'handled' },
  ])(
    'captures Pyodide packages offline ($distribution, unavailable package: $missingAtStartup)',
    async ({ distribution, missingAtStartup }) => {
      const page = await browser.newPage();
      try {
        const packageRoot = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';
        const root =
          distribution === 'npm' ? 'https://cdn.jsdelivr.net/npm/pyodide@0.26.2/' : packageRoot;
        const fetched = new Set<string>();
        const lockfile = {
          packages: {
            numpy: { file_name: 'numpy.whl', depends: [] },
            micropip: { file_name: 'micropip.whl', depends: ['packaging'] },
            packaging: { file_name: 'packaging.whl', depends: [] },
            unused: { file_name: 'unused.whl', depends: [] },
            optional: { file_name: 'optional.whl', depends: ['optional-runtime'] },
            'optional-runtime': { file_name: 'optional-runtime.whl', depends: [] },
          },
        };
        const entry = `globalThis.loadPyodide = async ({ indexURL }) => {
        const { packages } = await (await fetch(indexURL + 'pyodide-lock.json')).json();
        async function install(name) {
          const { file_name, depends } = packages[name];
          const dependencies = await Promise.all(depends.map(install));
          const wheel = await (await fetch(indexURL + file_name)).text();
          return [wheel, ...dependencies].join(' ');
        }
        return { async loadPackage(names, options) {
          try {
            const wheels = await Promise.all([names].flat().map(install));
            await new Promise(resolve => setTimeout(resolve, 400));
            return wheels.join(' ');
          } catch (error) {
            if (!options?.errorCallback) throw error;
            options.errorCallback(error.message);
          }
        } };
      };`;
        const optionalLoad =
          missingAtStartup === 'handled'
            ? "await python.loadPackage('optional', { errorCallback: () => { document.querySelector('button').textContent = 'Handled'; } });"
            : missingAtStartup === 'unhandled'
              ? "await python.loadPackage('optional');"
              : '';
        await load(
          page,
          await emittedFixture(
            `<script src="${root}pyodide.js"></script><output>Loading</output><button>Run</button>
          <script nomodule>python.loadPackage(['unused']);</script>
          <script>
            async function init() {
              const python = await loadPyodide();
              const numpy = await python.loadPackage(['numpy']);
              const micropip = await python.loadPackage('micropip');
              document.querySelector('button').onclick = () => python.loadPackage('optional');
              ${optionalLoad}
              document.querySelector('output').textContent = numpy + ' ' + micropip;
            }
            init();
          </script>`,
            async (url) => {
              const filename = new URL(url).pathname.split('/').at(-1)!;
              if (filename.endsWith('.whl') && !url.startsWith(packageRoot)) return null;
              fetched.add(filename);
              if (filename === 'optional-runtime.whl') return null;
              const content =
                filename === 'pyodide.js'
                  ? entry
                  : filename === 'pyodide-lock.json'
                    ? JSON.stringify(lockfile)
                    : filename === 'pyodide.asm.js'
                      ? '/* mock WebAssembly factory */'
                      : filename;
              return { bytes: new TextEncoder().encode(content), contentType: 'text/plain' };
            },
          ),
        );

        const host = page.locator('[data-interactive-static-host]');
        await page
          .locator(
            '[data-interactive-static-state="frozen"], [data-interactive-static-state="fallback"]',
          )
          .waitFor({ state: 'attached' });
        const diagnostic = await host.locator('[data-interactive-fallback]').textContent();
        const expectsFallback = missingAtStartup === 'unhandled';
        expect(
          await host.getAttribute('data-interactive-static-state'),
          diagnostic ?? undefined,
        ).toBe(expectsFallback ? 'fallback' : 'frozen');
        expect(fetched.has('unused.whl')).toBe(false);
        if (expectsFallback) {
          expect(diagnostic).toContain('Pyodide package unavailable offline: optional-runtime');
          return;
        }
        const child = page.frames().find((frame) => frame !== page.mainFrame())!;
        expect(await child.locator('output').textContent()).toBe(
          'numpy.whl micropip.whl packaging.whl',
        );
        if (missingAtStartup === 'handled') {
          expect(await child.locator('button').textContent()).toBe('Handled');
        }
      } finally {
        await page.close();
      }
    },
  );

  it.each([false, true])(
    'rejects a delayed micropip network install before capture (handled: %s)',
    async (handled) => {
      const page = await browser.newPage();
      const remoteRequests: string[] = [];
      await page.route('https://**', (route) => {
        remoteRequests.push(route.request().url());
        return route.abort();
      });
      try {
        const root = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';
        await load(
          page,
          await emittedFixture(
            `<script src="${root}pyodide.js"></script><output>Loading</output>
        <script>
          async function init() {
            const pyodide = await loadPyodide();
            await pyodide.runPythonAsync("import micropip; await micropip.install('widget-package')");
            document.querySelector('output').textContent = 'Ready';
          }
          ${handled ? "init().catch(() => { document.querySelector('output').textContent = 'Offline preview'; });" : 'init();'}
        </script>`,
            async (url) => ({
              bytes: new TextEncoder().encode(
                url.endsWith('/pyodide.js')
                  ? `
          window.loadPyodide = async () => ({
            async runPythonAsync() {
              await new Promise(resolve => setTimeout(resolve, 400));
              await fetch(new Request('https://pypi.org/pypi/widget-package/json'));
            }
          });`
                  : '42',
              ),
              contentType: 'application/octet-stream',
            }),
          ),
        );
        const host = page.locator('[data-interactive-static-host]');
        await page
          .locator(
            '[data-interactive-static-state="frozen"], [data-interactive-static-state="fallback"]',
          )
          .waitFor({ state: 'attached' });
        expect(await host.getAttribute('data-interactive-static-state')).toBe(
          handled ? 'frozen' : 'fallback',
        );
        if (handled) {
          const child = page.frames().find((frame) => frame !== page.mainFrame())!;
          expect(await child.locator('output').textContent()).toBe('Offline preview');
        } else {
          expect(await host.locator('[data-interactive-fallback]').textContent()).toContain(
            'Python package download unavailable offline',
          );
        }
        expect(remoteRequests).toEqual([]);
      } finally {
        await page.close();
      }
    },
  );

  it.each([
    { handled: true, state: 'frozen', delay: 400 },
    { handled: false, state: 'fallback', delay: 0 },
    { handled: false, state: 'fallback', delay: 400 },
  ])(
    'preserves the scene runtime error outcome ($state, $delay ms)',
    async ({ handled, state, delay }) => {
      const page = await browser.newPage();
      try {
        await load(
          page,
          await emittedFixture(`
          <output>Loading</output>
          <script>
            const ready = new Promise((resolve, reject) => {
              setTimeout(() => reject(new Error('Startup failed')), ${delay});
            });
            const result = window.__openmaicWaitForStaticRuntime(ready);
            ${handled ? "result.catch(() => { document.querySelector('output').textContent = 'Preview'; });" : ''}
          </script>`),
        );
        await page.waitForFunction(
          (expected) =>
            document
              .querySelector('[data-interactive-static-host]')
              ?.getAttribute('data-interactive-static-state') === expected,
          state,
          { timeout: 2500 },
        );
        if (handled) {
          const child = page.frames().find((frame) => frame !== page.mainFrame())!;
          expect(await child.locator('output').textContent()).toBe('Preview');
        }
      } finally {
        await page.close();
      }
    },
  );

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
