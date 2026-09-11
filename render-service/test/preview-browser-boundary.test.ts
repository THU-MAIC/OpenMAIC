import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL('..', import.meta.url));

// Use the service's real tsx loader, not Vitest's transform. Puppeteer sends
// only the callback source to Chromium, without the module's esbuild helpers.
it.each(['slide', 'interactive'])(
  'executes every %s preview callback across the tsx/browser boundary',
  async (type) => {
    const { stdout } = await execute(
      process.execPath,
      ['--import', 'tsx', 'test/preview-browser-boundary.fixture.mjs', type],
      { cwd, timeout: 15_000 },
    );
    expect(stdout.trim()).toBe(`${type} callbacks verified`);
  },
  20_000,
);

const executable =
  process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;

describe.skipIf(!executable)('real Chromium previews through tsx', () => {
  it.each(['slide', 'interactive', 'quiz', 'pbl'])(
    'renders a %s scene as PNG',
    async (type) => {
      const content = {
        slide: {
          type: 'slide',
          canvas: {
            id: 'canvas',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#fff',
              themeColors: ['#2563eb'],
              fontColor: '#111',
              fontName: 'sans-serif',
            },
            elements: [],
          },
        },
        interactive: {
          type: 'interactive',
          html: '<!doctype html><html><body style="background:#2563eb">Preview</body></html>',
        },
        quiz: { type: 'quiz', questions: [] },
        pbl: { type: 'pbl' },
      }[type];
      const scene = {
        id: 'preview-smoke',
        stageId: 'stage',
        order: 1,
        title: 'Preview',
        type,
        content,
        actions: [],
      };
      const { stdout } = await execute(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `
        import assert from 'node:assert/strict';
        import { ChromiumPreviewRenderer } from './src/preview-renderer.ts';
        const png = Buffer.from(await new ChromiumPreviewRenderer().render({
          scene: ${JSON.stringify(scene)}, stage: { id: 'stage', name: 'Course' },
          viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
          signal: AbortSignal.timeout(30000), deadlineMs: 30000,
        }));
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), 640);
        assert.equal(png.readUInt32BE(20), 360);
        console.log('PNG 640x360');
      `,
        ],
        { cwd, timeout: 35_000 },
      );
      expect(stdout.trim()).toBe('PNG 640x360');
    },
    40_000,
  );
});
