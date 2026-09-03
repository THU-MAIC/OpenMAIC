/** Synchronous single-page preview rendering through Chromium. */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import type {
  Action,
  InteractiveContent,
  PBLContent,
  QuizContent,
  Scene,
  SlideContent,
} from '@openmaic/dsl';
import puppeteer from 'puppeteer-core';
import type { Browser, Frame, Page } from 'puppeteer-core';

export type PreviewScene = Scene<
  Action,
  SlideContent | QuizContent | InteractiveContent | PBLContent
>;

export interface PreviewStageContext {
  id: string;
  name: string;
}

export interface PreviewViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface PreviewRequest {
  scene: PreviewScene;
  stage: PreviewStageContext;
  viewport: PreviewViewport;
  signal: AbortSignal;
  deadlineMs: number;
}

export interface PreviewRenderer {
  render(request: PreviewRequest): Promise<Uint8Array>;
}

export class PreviewTimeoutError extends Error {}

const PREVIEW_PROTOCOL_TIMEOUT_BUFFER_MS = 1_000;
const BROWSER_CLOSE_GRACE_MS = 250;

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function htmlDocument(body: string, scene: PreviewScene): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head>
<body data-scene-id="${escapeAttribute(scene.id)}">${body}</body></html>`;
}

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode,
): node is DefaultTreeAdapterTypes.Element {
  return !node.nodeName.startsWith('#');
}

function insertAt(html: string, offset: number, injection: string): string {
  return html.slice(0, offset) + injection + html.slice(offset);
}

/** Inject markup first in the parsed head without importing app-side code. */
function injectIntoDocumentHead(html: string, injection: string): string {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const htmlElement = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => isElement(node) && node.tagName === 'html',
  );
  const headElement = htmlElement?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element => isElement(node) && node.tagName === 'head',
  );
  const explicitHeadEnd = headElement?.sourceCodeLocation?.startTag?.endOffset;
  if (explicitHeadEnd !== undefined) return insertAt(html, explicitHeadEnd, injection);

  const firstHeadChildOffset = headElement?.childNodes.reduce<number | undefined>((first, node) => {
    const offset = node.sourceCodeLocation?.startOffset;
    if (offset === undefined) return first;
    return first === undefined ? offset : Math.min(first, offset);
  }, undefined);
  if (firstHeadChildOffset !== undefined) return insertAt(html, firstHeadChildOffset, injection);

  const explicitHtmlEnd = htmlElement?.sourceCodeLocation?.startTag?.endOffset;
  if (explicitHtmlEnd !== undefined) {
    return insertAt(html, explicitHtmlEnd, `<head>${injection}</head>`);
  }

  const doctype = document.childNodes.find((node) => node.nodeName === '#documentType');
  const doctypeEnd = doctype?.sourceCodeLocation?.endOffset;
  if (doctypeEnd !== undefined) return insertAt(html, doctypeEnd, `<head>${injection}</head>`);
  return `<head>${injection}</head>${html}`;
}

/**
 * Standalone counterpart of the app's `patchHtmlForIframe` storage behavior.
 * The sandbox intentionally omits allow-same-origin, so real Web Storage can
 * throw SecurityError; install in-memory stores before authored scripts run.
 */
const STORAGE_SHIM = `<script data-preview-storage-shim>
(function () {
  function makeStore() {
    var data = Object.create(null);
    return {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = Object.create(null); },
      key: function (i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      get length() { return Object.keys(data).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try { var store = window[name]; if (store) { store.getItem('__probe__'); ok = true; } } catch (error) { ok = false; }
    if (!ok) {
      try { Object.defineProperty(window, name, { value: makeStore(), configurable: true }); } catch (error) {}
    }
  });
})();
</script>`;

export function injectInteractiveStorageShim(html: string): string {
  return injectIntoDocumentHead(html, `\n${STORAGE_SHIM}\n`);
}

function slidePreviewMarkup(
  _scene: Extract<PreviewScene, { type: 'slide' }>,
  viewport: PreviewViewport,
): string {
  return renderToStaticMarkup(
    createElement('div', {
      id: 'preview-slide-root',
      style: { width: `${viewport.width}px`, height: `${viewport.height}px` },
    }),
  );
}

function interactivePreviewMarkup(
  scene: Extract<PreviewScene, { type: 'interactive' }>,
  viewport: PreviewViewport,
): string {
  if (!scene.content.html) throw new Error('Interactive page has no embedded HTML to preview');
  return renderToStaticMarkup(
    createElement('iframe', {
      title: scene.title,
      srcDoc: injectInteractiveStorageShim(scene.content.html),
      sandbox: 'allow-scripts allow-forms allow-modals',
      style: { width: `${viewport.width}px`, height: `${viewport.height}px`, border: 0 },
    }),
  );
}

function coverPreviewMarkup(
  scene: Extract<PreviewScene, { type: 'quiz' | 'pbl' }>,
  stage: PreviewStageContext,
  viewport: PreviewViewport,
): string {
  const isQuiz = scene.type === 'quiz';
  const project = scene.type === 'pbl' ? scene.content.projectV2 : undefined;
  const heading = project?.title || scene.title;
  const description = project?.description || stage.name;
  const count = isQuiz ? scene.content.questions.length : (project?.milestones.length ?? 0);
  const countLabel = isQuiz ? `${count} questions` : count > 0 ? `${count} stages` : 'Project';

  return renderToStaticMarkup(
    createElement(
      'main',
      {
        style: {
          width: `${viewport.width}px`,
          height: `${viewport.height}px`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '8%',
          background: isQuiz
            ? 'linear-gradient(135deg,#312e81,#2563eb)'
            : 'linear-gradient(135deg,#064e3b,#0f766e)',
          color: '#fff',
          fontFamily: 'Inter, Noto Sans, system-ui, sans-serif',
        },
      },
      createElement(
        'section',
        { style: { width: '100%', maxWidth: '900px', textAlign: 'center' } },
        createElement(
          'div',
          {
            style: {
              display: 'inline-block',
              marginBottom: '24px',
              padding: '8px 18px',
              borderRadius: '999px',
              background: 'rgba(255,255,255,.16)',
              fontSize: '20px',
            },
          },
          countLabel,
        ),
        createElement('h1', { style: { margin: 0, fontSize: '64px', lineHeight: 1.1 } }, heading),
        createElement(
          'p',
          { style: { margin: '24px auto 0', fontSize: '26px', opacity: 0.82 } },
          description,
        ),
      ),
    ),
  );
}

/** Assemble the complete one-scene document inside render-service. */
export function buildPreviewHtml(
  scene: PreviewScene,
  stage: PreviewStageContext,
  viewport: PreviewViewport,
): string {
  const markup =
    scene.type === 'slide'
      ? slidePreviewMarkup(scene, viewport)
      : scene.type === 'interactive'
        ? interactivePreviewMarkup(scene, viewport)
        : coverPreviewMarkup(scene, stage, viewport);
  return htmlDocument(markup, scene);
}

let slideClientBundle: Promise<string> | undefined;
type SlideBundleBuilder = typeof build;

/** Bundle the browser-only SlideCanvas mount once per service process. */
export function buildSlideClientBundle(builder: SlideBundleBuilder = build): Promise<string> {
  if (slideClientBundle) return slideClientBundle;
  const candidate = builder({
    stdin: {
      sourcefile: 'preview-slide-client.js',
      resolveDir: dirname(fileURLToPath(import.meta.url)),
      contents: `
        import React from 'react';
        import { flushSync } from 'react-dom';
        import { createRoot } from 'react-dom/client';
        import { SlideCanvas } from '@openmaic/renderer';

        const props = window.__OPENMAIC_PREVIEW_PROPS__;
        const root = document.getElementById('preview-slide-root');
        if (!props || !root) throw new Error('Preview slide mount data is missing');
        const canvas = props.slide;
        const nativeWidth = canvas.viewportSize || 1000;
        const nativeHeight = nativeWidth * (canvas.viewportRatio || 0.5625);
        const scale = Math.min(props.viewport.width / nativeWidth, props.viewport.height / nativeHeight);
        const renderedWidth = nativeWidth * scale;
        const renderedHeight = nativeHeight * scale;
        const canvasNode = React.createElement(SlideCanvas, {
          slide: canvas,
          scale,
          chrome: false,
          style: { width: renderedWidth + 'px', height: renderedHeight + 'px' },
        });
        const frame = React.createElement('main', {
          style: {
            width: props.viewport.width + 'px',
            height: props.viewport.height + 'px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            background: '#fff',
          },
        }, React.createElement('div', {
          style: { width: renderedWidth + 'px', height: renderedHeight + 'px' },
        }, canvasNode));
        flushSync(() => createRoot(root).render(frame));
        window.__OPENMAIC_PREVIEW_MOUNTED__ = true;
      `,
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error('Failed to build the preview slide client');
    return output.text;
  });
  const retryable = candidate.catch((error: unknown) => {
    if (slideClientBundle === retryable) slideClientBundle = undefined;
    throw error;
  });
  slideClientBundle = retryable;
  return slideClientBundle;
}

type AssetDocument = Page | Frame;

/** Wait for fonts, images, client effects, and layout mutations to settle. */
export async function waitForDocumentAssets(document: AssetDocument): Promise<void> {
  await document.evaluate(async () => {
    await globalThis.document.fonts?.ready.catch(() => undefined);
    await Promise.all(
      Array.from(globalThis.document.images, (image) =>
        image.complete
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              image.addEventListener('load', () => resolve(), { once: true });
              image.addEventListener('error', () => resolve(), { once: true });
              setTimeout(resolve, 2_000);
            }),
      ),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await new Promise<void>((resolve) => {
      let quietTimer = setTimeout(done, 100);
      const maximumTimer = setTimeout(done, 2_000);
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, 100);
      });
      function done() {
        clearTimeout(quietTimer);
        clearTimeout(maximumTimer);
        observer.disconnect();
        resolve();
      }
      observer.observe(globalThis.document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
    });
  });
}

/** Wait for a srcDoc iframe and the assets inside its browsing context. */
export async function waitForInteractiveFrame(page: Page): Promise<void> {
  const iframe = await page.waitForSelector('iframe');
  const frame = await iframe?.contentFrame();
  if (!frame) throw new Error('Interactive preview iframe did not load');
  await frame.waitForFunction(
    () => location.href === 'about:srcdoc' && document.readyState === 'complete',
  );
  await waitForDocumentAssets(frame);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Preview aborted');
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(abortError(signal));
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function forceKillBrowser(browser: Browser): void {
  try {
    browser.process()?.kill('SIGKILL');
  } catch {
    // The process may already have exited; bounded close below remains best effort.
  }
}

export async function closeBrowserBounded(browser: Browser): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, BROWSER_CLOSE_GRACE_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (timedOut) forceKillBrowser(browser);
}

async function launchWithAbort(launch: Promise<Browser>, signal: AbortSignal): Promise<Browser> {
  try {
    return await raceWithAbort(launch, signal);
  } catch (error) {
    if (signal.aborted) {
      void launch
        .then(async (browser) => {
          forceKillBrowser(browser);
          await closeBrowserBounded(browser);
        })
        .catch(() => {});
    }
    throw error;
  }
}

/** Mount the slide client while surfacing synchronous in-page crashes immediately. */
export async function mountSlideClient(page: Page, bundle: string): Promise<void> {
  let rejectPageError!: (error: Error) => void;
  const pageError = new Promise<never>((_resolve, reject) => {
    rejectPageError = reject;
  });
  const onPageError = (error: unknown) =>
    rejectPageError(error instanceof Error ? error : new Error(String(error)));
  page.on('pageerror', onPageError);
  try {
    await Promise.race([
      (async () => {
        await page.addScriptTag({ content: bundle });
        await page.waitForFunction(() => '__OPENMAIC_PREVIEW_MOUNTED__' in window);
      })(),
      pageError,
    ]);
  } finally {
    page.off('pageerror', onPageError);
  }
}

export interface ChromiumPreviewRendererOptions {
  browserLauncher?: Pick<typeof puppeteer, 'launch'>;
}

export class ChromiumPreviewRenderer implements PreviewRenderer {
  private readonly browserLauncher: Pick<typeof puppeteer, 'launch'>;

  constructor(options: ChromiumPreviewRendererOptions = {}) {
    this.browserLauncher = options.browserLauncher ?? puppeteer;
  }

  async render(request: PreviewRequest): Promise<Uint8Array> {
    if (request.signal.aborted) throw abortError(request.signal);

    const executablePath =
      process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!executablePath) {
      throw new Error('Chromium executable is not configured for preview rendering');
    }

    const browser = await launchWithAbort(
      this.browserLauncher.launch({
        executablePath,
        headless: true,
        protocolTimeout: request.deadlineMs + PREVIEW_PROTOCOL_TIMEOUT_BUFFER_MS,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      }),
      request.signal,
    );
    const closeOnAbort = () => forceKillBrowser(browser);
    request.signal.addEventListener('abort', closeOnAbort, { once: true });

    try {
      return await raceWithAbort(
        (async () => {
          const page = await browser.newPage();
          await page.setViewport(request.viewport);
          await page.setContent(buildPreviewHtml(request.scene, request.stage, request.viewport), {
            waitUntil: 'domcontentloaded',
          });

          if (request.scene.type === 'slide') {
            await page.evaluate(
              (slide, viewport) => {
                Object.assign(window, {
                  __OPENMAIC_PREVIEW_PROPS__: { slide, viewport },
                });
              },
              request.scene.content.canvas,
              request.viewport,
            );
            await mountSlideClient(page, await buildSlideClientBundle());
          }

          const selected = await page.evaluate(
            (sceneId) => document.body.getAttribute('data-scene-id') === sceneId,
            request.scene.id,
          );
          if (!selected) {
            throw new Error(
              `Requested scene was not found in the preview page (${request.scene.id})`,
            );
          }

          if (request.scene.type === 'interactive') await waitForInteractiveFrame(page);
          else await waitForDocumentAssets(page);

          const png = await page.screenshot({ type: 'png', optimizeForSpeed: true });
          return new Uint8Array(png);
        })(),
        request.signal,
      );
    } catch (error) {
      if (request.signal.aborted) throw abortError(request.signal);
      throw error;
    } finally {
      request.signal.removeEventListener('abort', closeOnAbort);
      await closeBrowserBounded(browser);
    }
  }
}
