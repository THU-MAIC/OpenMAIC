/** Synchronous single-page preview rendering through Chromium. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlideCanvas } from '@openmaic/renderer';
import type {
  Action,
  InteractiveContent,
  PBLContent,
  QuizContent,
  Scene,
  SlideContent,
} from '@openmaic/dsl';
import puppeteer from 'puppeteer-core';
import type { Browser } from 'puppeteer-core';

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
}

export interface PreviewRenderer {
  render(request: PreviewRequest): Promise<Uint8Array>;
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
  scene: Extract<PreviewScene, { type: 'slide' }>,
  viewport: PreviewViewport,
): string {
  const canvas = scene.content.canvas;
  const nativeWidth = canvas.viewportSize || 1000;
  const nativeHeight = nativeWidth * (canvas.viewportRatio || 0.5625);
  const scale = Math.min(viewport.width / nativeWidth, viewport.height / nativeHeight);
  const renderedWidth = nativeWidth * scale;
  const renderedHeight = nativeHeight * scale;

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
          overflow: 'hidden',
          background: '#fff',
        },
      },
      createElement(
        'div',
        { style: { width: `${renderedWidth}px`, height: `${renderedHeight}px` } },
        createElement(SlideCanvas, {
          slide: canvas,
          scale,
          chrome: false,
          style: { width: `${renderedWidth}px`, height: `${renderedHeight}px` },
        }),
      ),
    ),
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
  async render(request: PreviewRequest): Promise<Uint8Array> {
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

      const selected = await page.evaluate(
        (sceneId) => document.body.getAttribute('data-scene-id') === sceneId,
        request.scene.id,
      );
      if (!selected) {
        throw new Error(`Requested scene was not found in the preview page (${request.scene.id})`);
      }

      await page.evaluate(async () => {
        await document.fonts?.ready.catch(() => undefined);
        await Promise.all(
          Array.from(document.images, (image) =>
            image.complete
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  image.addEventListener('load', () => resolve(), { once: true });
                  image.addEventListener('error', () => resolve(), { once: true });
                  setTimeout(resolve, 2_000);
                }),
          ),
        );
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      if (request.signal.aborted) throw timeoutError();

      const png = await page.screenshot({ type: 'png', optimizeForSpeed: true });
      return new Uint8Array(png);
    } catch (error) {
      if (request.signal.aborted) throw timeoutError();
      throw error;
    } finally {
      request.signal.removeEventListener('abort', closeOnAbort);
      await browser.close().catch(() => {});
    }
  }
}
