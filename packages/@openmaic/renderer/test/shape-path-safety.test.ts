import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

async function renderInWorker(
  path: string,
  { viewBox = [100, 100], width = 100, height = 100 } = {},
): Promise<string> {
  const worker = new Worker(new URL('./shape-render.worker.mjs', import.meta.url));
  try {
    return await new Promise<string>((resolve, reject) => {
      let timer = setTimeout(() => reject(new Error('SDK worker failed to initialize')), 5_000);
      worker.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.on('message', (message) => {
        if (message.ready) {
          clearTimeout(timer);
          timer = setTimeout(
            () => reject(new Error('SDK shape rendering did not terminate within 500ms')),
            500,
          );
          worker.postMessage({
            id: 'historical-shape',
            type: 'shape',
            left: 0,
            top: 0,
            width,
            height,
            rotate: 0,
            viewBox,
            path,
            fill: '#fff',
            fixedRatio: false,
            text: {
              content: '<p>Preserved label</p>',
              align: 'middle',
              defaultFontName: 'Arial',
              defaultColor: '#000',
            },
          });
        } else {
          clearTimeout(timer);
          if (message.error) reject(new Error(message.error));
          else resolve(message.html);
        }
      });
    });
  } finally {
    await worker.terminate();
  }
}

describe('SDK historical shape rendering (build renderer before running)', () => {
  it.each(['M 0 0 Z 1 1', 'M0 0 L', '<svg/>', 'M0 0 L1e999 0'])(
    'terminates malformed path %s, retaining its label',
    async (path) => {
      const html = await renderInWorker(path);
      expect(html).toContain('data-shape-geometry-error=');
      expect(html).toContain('base-element-text');
      expect(html).not.toContain('<svg');
      expect(html).toContain('Preserved label');
      expect(html).not.toMatch(/scale\([^)]*(?:NaN|Infinity)/);
    },
  );

  it('does not apply new model-input complexity limits to historical rendering', async () => {
    const path = 'M0 0' + ' L1 1'.repeat(10_001);
    const html = await renderInWorker(path);
    expect(html).not.toContain('data-shape-geometry-error=');
    expect(html).toContain(`d="${path}"`);
  });

  it.each([Infinity, NaN, 0, -1])(
    'uses finite label dimensions for historical width %s',
    async (width) => {
      const html = await renderInWorker('M0 0 L100 100', { width });
      expect(html).toContain('base-element-text');
      expect(html).not.toContain('<svg');
      expect(html).toContain('Preserved label');
      expect(html).not.toMatch(/Infinity|NaN/);
    },
  );

  it('omits invalid geometry when historical viewBox is zero', async () => {
    const html = await renderInWorker('M0 0 L100 100', { viewBox: [0, 0] });
    expect(html).toContain('base-element-text');
    expect(html).not.toContain('<svg');
    expect(html).toContain('Preserved label');
    expect(html).not.toContain('Infinity');
  });
});
