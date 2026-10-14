import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  inlineKatexFonts,
  katexPreviewStylesheet,
  resolveKatexDistDirectory,
} from '../src/preview-katex.js';
import { buildPreviewHtml, type PreviewScene } from '../src/preview-renderer.js';

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL('..', import.meta.url));
const viewport = { width: 640, height: 360, deviceScaleFactor: 1 };
const stage = { id: 'stage', name: 'Course' };

function scene(content: unknown, type: string): PreviewScene {
  return {
    id: 'scene',
    stageId: 'stage',
    order: 1,
    title: 'Scene',
    type,
    content,
    actions: [],
  } as unknown as PreviewScene;
}

describe('KaTeX stylesheet for slide previews', () => {
  it('inlines every KaTeX face as woff2 and keeps the layout rules', () => {
    const css = katexPreviewStylesheet();
    const source = readFileSync(join(resolveKatexDistDirectory(), 'katex.min.css'), 'utf8');
    const faces = source.match(/@font-face\{/g)?.length ?? 0;

    expect(faces).toBeGreaterThan(0);
    expect(
      css.match(/src:url\(data:font\/woff2;base64,[A-Za-z0-9+/=]+\) format\("woff2"\)/g),
    ).toHaveLength(faces);
    expect(css).not.toContain('url(fonts/');
    expect(css).toContain('font-family:KaTeX_Math');
    expect(css).toContain('.katex .mfrac');
  });

  it('refuses a face without a woff2 source', () => {
    expect(() =>
      inlineKatexFonts('@font-face{font-family:X;src:url(fonts/X.ttf) format("truetype")}', () =>
        Buffer.from(''),
      ),
    ).toThrow('without a woff2 source');
  });

  it('ships the stylesheet with slide previews only', () => {
    const slide = buildPreviewHtml(
      scene({ type: 'slide', canvas: { id: 'c', elements: [] } }, 'slide'),
      stage,
      viewport,
    );
    const quiz = buildPreviewHtml(scene({ type: 'quiz', questions: [] }, 'quiz'), stage, viewport);

    expect(slide).toContain('<style data-preview-katex>');
    expect(slide.indexOf('data-preview-katex')).toBeLessThan(slide.indexOf('</head>'));
    expect(quiz).not.toContain('data-preview-katex');
  });
});

const executable =
  process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;

describe.skipIf(!executable)('inline math in real Chromium previews', () => {
  it('typesets every stored inline formula with KaTeX fonts before capture', async () => {
    const { stdout } = await execute(
      process.execPath,
      ['--import', 'tsx', 'test/preview-inline-math.fixture.mjs'],
      { cwd, timeout: 35_000 },
    );
    expect(stdout.trim()).toBe('inline math typeset');
  }, 40_000);
});
