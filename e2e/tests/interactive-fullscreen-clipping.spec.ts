import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import type * as ClientRects from '../../lib/edit/visible-client-rect';

// Exercise the production clipping calculation with real browser fullscreen geometry.
const script = buildSync({
  entryPoints: ['lib/edit/visible-client-rect.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'clientRects',
}).outputFiles[0].text;

function visibleBox(page: Page, selector = '#slot') {
  return page.evaluate((selector) => {
    const { clientRects } = window as typeof window & { clientRects: typeof ClientRects };
    return clientRects.visibleClientRect(document.querySelector(selector)!);
  }, selector);
}

async function enterFullscreen(page: Page, selector = '#player') {
  await page.evaluate((selector) => {
    document.querySelector<HTMLButtonElement>('#enter')!.onclick = () =>
      document.querySelector(selector)!.requestFullscreen();
  }, selector);
  await page.getByRole('button', { name: 'Fullscreen' }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id))
    .toBe(selector.slice(1));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`
    <style>
      body { margin: 0; }
      #workspace { position: absolute; left: 450px; top: 100px; width: 600px; height: 400px; overflow: hidden; }
      #player { width: 900px; height: 650px; overflow: hidden; }
      #canvas, #slot { width: 100%; height: 100%; }
      #enter { position: absolute; z-index: 1; }
    </style>
    <div id="workspace">
      <div id="player"><button id="enter">Fullscreen</button><div id="canvas"><div id="slot"></div></div></div>
    </div>
  `);
  await page.addScriptTag({ content: script });
});

test('fullscreen ignores workspace clipping, follows resize, and restores clipping on exit', async ({
  page,
}) => {
  const windowed = { left: 450, top: 100, width: 600, height: 400 };
  expect(await visibleBox(page)).toEqual(windowed);

  await enterFullscreen(page);
  await expect.poll(() => visibleBox(page)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });

  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => visibleBox(page)).toEqual(windowed);
  await page.setViewportSize({ width: 1280, height: 720 });
  await enterFullscreen(page);
  await expect.poll(() => visibleBox(page)).toEqual({ left: 0, top: 0, width: 1280, height: 720 });

  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => visibleBox(page)).toEqual(windowed);
});

test('fullscreen still clips at inner panels and at the fullscreen element itself', async ({
  page,
}) => {
  await page.locator('#canvas').evaluate((canvas) => {
    canvas.style.cssText =
      'position:relative;left:40px;top:30px;width:500px;height:300px;overflow:hidden';
    (canvas.firstElementChild as HTMLElement).style.cssText = 'width:1800px;height:1200px';
  });
  await enterFullscreen(page);
  await expect.poll(() => visibleBox(page)).toEqual({ left: 40, top: 30, width: 500, height: 300 });

  await page.locator('#canvas').evaluate((canvas) => {
    canvas.style.width = '1600px';
    canvas.style.height = '1000px';
  });
  await expect
    .poll(() => visibleBox(page))
    .toEqual({ left: 40, top: 30, width: 1400, height: 870 });
});

test('a fullscreen node ignores its own ancestors without changing clipping for other nodes', async ({
  page,
}) => {
  await page.locator('#workspace').evaluate((workspace) => {
    const other = document.createElement('div');
    other.id = 'other';
    other.style.cssText = 'position:absolute;left:0;top:0;width:900px;height:650px';
    workspace.append(other);
  });
  await enterFullscreen(page, '#slot');
  await expect.poll(() => visibleBox(page)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  expect(await visibleBox(page, '#other')).toEqual({
    left: 450,
    top: 100,
    width: 600,
    height: 400,
  });
});
