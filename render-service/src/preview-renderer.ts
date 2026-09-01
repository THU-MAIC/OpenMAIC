/** Synchronous single-page preview rendering through Chromium. */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
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

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutNodeSnapshot {
  selector: string;
  rect: LayoutRect;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  fontSize: number;
  /** Effective ancestor transform scale applied to the rendered glyphs. */
  renderScale?: number;
  containsText: boolean;
  hasDirectText: boolean;
  isIntentionalScroller: boolean;
  insideIntentionalScroller: boolean;
}

export interface LayoutSnapshot {
  viewport: Pick<PreviewViewport, 'width' | 'height'>;
  document: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  minimumTextPx: number;
  nodes: LayoutNodeSnapshot[];
}

export type LayoutIssue =
  | {
      code: 'document-overflow';
      selector: 'html';
      overflow: { x: number; y: number };
    }
  | {
      code: 'element-outside-viewport';
      selector: string;
      rect: LayoutRect;
    }
  | {
      code: 'text-overflow';
      selector: string;
      overflow: { x: number; y: number };
    }
  | {
      code: 'small-text';
      selector: string;
      fontSize: number;
      minimumTextPx: number;
    };

export interface LayoutDiagnostics {
  version: 1;
  viewport: Pick<PreviewViewport, 'width' | 'height'>;
  pass: boolean;
  document: LayoutSnapshot['document'];
  issues: LayoutIssue[];
  truncated: boolean;
}

export interface PreviewRenderResult {
  png: Uint8Array;
  diagnostics: LayoutDiagnostics;
}

export interface PreviewRequest {
  scene: PreviewScene;
  stage: PreviewStageContext;
  viewport: PreviewViewport;
  signal: AbortSignal;
}

export interface PreviewRenderer {
  render(request: PreviewRequest): Promise<PreviewRenderResult>;
}

export class PreviewTimeoutError extends Error {}

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
      srcDoc: scene.content.html,
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

function timeoutError(): PreviewTimeoutError {
  return new PreviewTimeoutError('Preview exceeded the deadline');
}

let slideClientBundle: Promise<string> | undefined;

/** Bundle the browser-only SlideCanvas mount once per service process. */
export function buildSlideClientBundle(): Promise<string> {
  slideClientBundle ??= build({
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
  return slideClientBundle;
}

type AssetDocument = Page | Frame;

const MAX_LAYOUT_ISSUES = 20;
const LAYOUT_TOLERANCE_PX = 1;

/** Readability is judged in rendered screen pixels, not authored canvas units. */
export function minimumTextPxForPreview(
  _sceneType: PreviewScene['type'],
  _viewport: PreviewViewport,
): number {
  return 16;
}

/** Apply the quality policy to serializable browser measurements. */
export function analyzeLayoutSnapshot(snapshot: LayoutSnapshot): LayoutDiagnostics {
  const issues: LayoutIssue[] = [];
  const push = (issue: LayoutIssue) => {
    if (issues.length < MAX_LAYOUT_ISSUES) issues.push(issue);
  };
  const documentOverflow = {
    x: Math.max(0, snapshot.document.scrollWidth - snapshot.viewport.width),
    y: Math.max(0, snapshot.document.scrollHeight - snapshot.viewport.height),
  };
  if (documentOverflow.x > LAYOUT_TOLERANCE_PX || documentOverflow.y > LAYOUT_TOLERANCE_PX) {
    push({ code: 'document-overflow', selector: 'html', overflow: documentOverflow });
  }

  for (const node of snapshot.nodes) {
    const outside =
      node.rect.x < -LAYOUT_TOLERANCE_PX ||
      node.rect.y < -LAYOUT_TOLERANCE_PX ||
      node.rect.x + node.rect.width > snapshot.viewport.width + LAYOUT_TOLERANCE_PX ||
      node.rect.y + node.rect.height > snapshot.viewport.height + LAYOUT_TOLERANCE_PX;
    if (outside && !node.insideIntentionalScroller) {
      push({ code: 'element-outside-viewport', selector: node.selector, rect: node.rect });
    }
    const textOverflow = {
      x: Math.max(0, node.scrollWidth - node.clientWidth),
      y: Math.max(0, node.scrollHeight - node.clientHeight),
    };
    if (
      node.containsText &&
      !node.isIntentionalScroller &&
      !node.insideIntentionalScroller &&
      (textOverflow.x > LAYOUT_TOLERANCE_PX || textOverflow.y > LAYOUT_TOLERANCE_PX)
    ) {
      push({ code: 'text-overflow', selector: node.selector, overflow: textOverflow });
    }
    const renderedFontSize = node.fontSize * (node.renderScale ?? 1);
    if (node.hasDirectText && renderedFontSize < snapshot.minimumTextPx) {
      push({
        code: 'small-text',
        selector: node.selector,
        fontSize: Math.round(renderedFontSize * 100) / 100,
        minimumTextPx: snapshot.minimumTextPx,
      });
    }
  }

  const totalIssueCount =
    (documentOverflow.x > LAYOUT_TOLERANCE_PX || documentOverflow.y > LAYOUT_TOLERANCE_PX ? 1 : 0) +
    snapshot.nodes.reduce((count, node) => {
      const outside =
        !node.insideIntentionalScroller &&
        (node.rect.x < -LAYOUT_TOLERANCE_PX ||
          node.rect.y < -LAYOUT_TOLERANCE_PX ||
          node.rect.x + node.rect.width > snapshot.viewport.width + LAYOUT_TOLERANCE_PX ||
          node.rect.y + node.rect.height > snapshot.viewport.height + LAYOUT_TOLERANCE_PX);
      const overflow =
        node.containsText &&
        !node.isIntentionalScroller &&
        !node.insideIntentionalScroller &&
        (node.scrollWidth - node.clientWidth > LAYOUT_TOLERANCE_PX ||
          node.scrollHeight - node.clientHeight > LAYOUT_TOLERANCE_PX);
      const small =
        node.hasDirectText && node.fontSize * (node.renderScale ?? 1) < snapshot.minimumTextPx;
      return count + Number(outside) + Number(overflow) + Number(small);
    }, 0);

  return {
    version: 1,
    viewport: snapshot.viewport,
    pass: totalIssueCount === 0,
    document: snapshot.document,
    issues,
    truncated: totalIssueCount > issues.length,
  };
}

/** Measure the current page or interactive iframe without leaking learner text. */
export async function collectLayoutDiagnostics(
  target: AssetDocument,
  viewport: PreviewViewport,
  minimumTextPx: number,
): Promise<LayoutDiagnostics> {
  const snapshot = await target.evaluate(
    ({ width, height, minimumTextPx: minimum }) => {
      const root = document.documentElement;
      const body = document.body;
      const nodes = Array.from(body.querySelectorAll<HTMLElement>('*')).flatMap((element) => {
        if (!(element instanceof HTMLElement)) return [];
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) === 0
        ) {
          return [];
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return [];
        const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
        const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
        const renderScale = Math.min(scaleX, scaleY);
        const hasDirectText = Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
        );
        const containsText = Boolean(element.textContent?.trim());
        let selector: string;
        if (element.id) {
          const escaped = globalThis.CSS?.escape
            ? globalThis.CSS.escape(element.id)
            : element.id.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
          selector = `#${escaped}`.slice(0, 180);
        } else {
          const parts: string[] = [];
          let current: HTMLElement | null = element;
          while (current && current !== body && parts.length < 4) {
            const tag = current.tagName.toLowerCase();
            const siblings = current.parentElement
              ? Array.from(current.parentElement.children).filter(
                  (child) => child.tagName === current!.tagName,
                )
              : [];
            const suffix =
              siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
            parts.unshift(`${tag}${suffix}`);
            current = current.parentElement;
          }
          selector = (parts.length ? `body>${parts.join('>')}` : 'body').slice(0, 180);
        }
        const isIntentionalScroller =
          (/^(auto|scroll)$/.test(style.overflowX) &&
            element.scrollWidth > element.clientWidth + 1) ||
          (/^(auto|scroll)$/.test(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 1);
        let insideIntentionalScroller = false;
        let current: HTMLElement | null = element.parentElement;
        while (current && current !== root && current !== body) {
          const currentStyle = getComputedStyle(current);
          const scrollsX =
            /^(auto|scroll)$/.test(currentStyle.overflowX) &&
            current.scrollWidth > current.clientWidth + 1;
          const scrollsY =
            /^(auto|scroll)$/.test(currentStyle.overflowY) &&
            current.scrollHeight > current.clientHeight + 1;
          if (scrollsX || scrollsY) {
            insideIntentionalScroller = true;
            break;
          }
          current = current.parentElement;
        }
        return [
          {
            selector,
            rect: {
              x: Math.round(rect.x * 100) / 100,
              y: Math.round(rect.y * 100) / 100,
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100,
            },
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            fontSize: Math.round((Number.parseFloat(style.fontSize) || 0) * 100) / 100,
            renderScale:
              Number.isFinite(renderScale) && renderScale > 0
                ? Math.round(renderScale * 10_000) / 10_000
                : 1,
            containsText,
            hasDirectText,
            isIntentionalScroller,
            insideIntentionalScroller,
          },
        ];
      });
      return {
        viewport: { width, height },
        document: {
          scrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
          scrollHeight: Math.max(root.scrollHeight, body.scrollHeight),
          clientWidth: root.clientWidth,
          clientHeight: root.clientHeight,
        },
        minimumTextPx: minimum,
        nodes,
      };
    },
    { width: viewport.width, height: viewport.height, minimumTextPx },
  );
  return analyzeLayoutSnapshot(snapshot);
}

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
      let quietTimer: ReturnType<typeof setTimeout>;
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          clearTimeout(maximumTimer);
          observer.disconnect();
          resolve();
        }, 100);
      });
      const maximumTimer = setTimeout(() => {
        clearTimeout(quietTimer);
        observer.disconnect();
        resolve();
      }, 2_000);
      quietTimer = setTimeout(() => {
        clearTimeout(maximumTimer);
        observer.disconnect();
        resolve();
      }, 100);
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

async function launchWithAbort(launch: Promise<Browser>, signal: AbortSignal): Promise<Browser> {
  let rejectAbort!: (error: PreviewTimeoutError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(timeoutError());
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    return await Promise.race([launch, aborted]);
  } catch (error) {
    if (signal.aborted) {
      void launch.then((browser) => browser.close()).catch(() => {});
      throw timeoutError();
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export class ChromiumPreviewRenderer implements PreviewRenderer {
  async render(request: PreviewRequest): Promise<PreviewRenderResult> {
    if (request.signal.aborted) throw timeoutError();

    const executablePath =
      process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!executablePath) {
      throw new Error('Chromium executable is not configured for preview rendering');
    }

    const browser = await launchWithAbort(
      puppeteer.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      }),
      request.signal,
    );
    const closeOnAbort = () => void browser.close();
    request.signal.addEventListener('abort', closeOnAbort, { once: true });

    try {
      const page = await browser.newPage();
      await page.setViewport(request.viewport);
      await page.setContent(buildPreviewHtml(request.scene, request.stage, request.viewport), {
        waitUntil: 'domcontentloaded',
      });
      if (request.signal.aborted) throw timeoutError();

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
        await page.addScriptTag({ content: await buildSlideClientBundle() });
        await page.waitForFunction(() => '__OPENMAIC_PREVIEW_MOUNTED__' in window);
      }

      const selected = await page.evaluate(
        (sceneId) => document.body.getAttribute('data-scene-id') === sceneId,
        request.scene.id,
      );
      if (!selected) {
        throw new Error(`Requested scene was not found in the preview page (${request.scene.id})`);
      }

      if (request.scene.type === 'interactive') await waitForInteractiveFrame(page);
      else await waitForDocumentAssets(page);
      if (request.signal.aborted) throw timeoutError();

      let diagnosticsTarget: AssetDocument = page;
      if (request.scene.type === 'interactive') {
        const iframe = await page.waitForSelector('iframe');
        const frame = await iframe?.contentFrame();
        if (!frame) throw new Error('Interactive preview iframe did not load');
        diagnosticsTarget = frame;
      }
      const minimumTextPx = minimumTextPxForPreview(request.scene.type, request.viewport);
      const diagnostics = await collectLayoutDiagnostics(
        diagnosticsTarget,
        request.viewport,
        minimumTextPx,
      );

      const png = await page.screenshot({ type: 'png', optimizeForSpeed: true });
      return { png: new Uint8Array(png), diagnostics };
    } catch (error) {
      if (request.signal.aborted) throw timeoutError();
      throw error;
    } finally {
      request.signal.removeEventListener('abort', closeOnAbort);
      await browser.close().catch(() => {});
    }
  }
}
