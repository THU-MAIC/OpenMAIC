import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

/**
 * #2121 through the real interactive chain: the placeholder's per-frame
 * measurement, the keep-alive pool and the host's portal and clipped wrapper
 * (as in interactive-observation-http, only unrelated stores are stubbed).
 *
 * The workbench is not part of the e2e build, so only its layout is mirrored:
 * the navigation and conversation columns take the left 640px, and the course
 * pane clips its content. The player stage is fullscreened the way
 * PlaybackChromeRoot does it, with `requestFullscreen()` on the stage element.
 */
const IFRAME = 'iframe[title="Interactive Scene s"]';
const ACTIVITY = `<!doctype html><html><body style="margin:0;width:1280px;height:720px;position:relative">
<button id="edge" style="position:absolute;left:24px;top:340px">Left edge</button>
<output id="count" style="position:absolute;left:620px;top:340px">0</output>
<script>
  var n = 0;
  document.getElementById('edge').addEventListener('click', function () {
    document.getElementById('count').textContent = String(++n);
  });
</script>
</body></html>`;

const LAYOUT = `<!doctype html><html><head><style>
  body { margin: 0; }
  .w-full { width: 100%; } .h-full { height: 100%; }
  #shell { display: flex; height: 100vh; overflow: hidden; }
  #rail { width: 260px; flex: none; }
  #chat { width: 380px; flex: none; }
  #pane { flex: 1; min-width: 0; display: flex; overflow: hidden; }
  #stage { flex: 1; display: flex; overflow: hidden; background: #f9fafb; }
  #canvas { flex: 1; min-width: 0; position: relative; overflow: hidden; }
</style></head><body>
  <div id="shell">
    <nav id="rail"><button id="enter">Fullscreen</button></nav>
    <aside id="chat">Conversation</aside>
    <section id="pane"><div id="stage"><div id="canvas"></div></div></section>
  </div>
  <div id="host"></div>
  <script>
    document.getElementById('enter').onclick = () =>
      document.getElementById('stage').requestFullscreen();
  </script>
</body></html>`;

const STUBS = './e2e/fixtures/interactive-host-stubs.ts';
const bundle = buildSync({
  absWorkingDir: process.cwd(),
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import { createRoot } from 'react-dom/client';
import { InteractiveRenderer } from './components/scene-renderers/interactive-renderer';
import { InteractiveIframeHost } from './components/scene-renderers/InteractiveIframeHost';
const html = ${JSON.stringify(ACTIVITY)};
createRoot(document.getElementById('canvas')).render(
  <InteractiveRenderer sceneId="s" content={{ type: 'interactive', url: '', html }} />,
);
createRoot(document.getElementById('host')).render(<InteractiveIframeHost />);
`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  logLevel: 'error',
  alias: {
    '@/lib/hooks/use-i18n': STUBS,
    '@/lib/store/canvas': STUBS,
    '@/lib/store/element-refs': STUBS,
  },
  // Next inlines NODE_ENV at build time; mirror that for React.
  define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;

type Box = { left: number; top: number; width: number; height: number };

/** The box the iframe is actually painted in: its clipping wrapper. */
function wrapperBox(page: Page): Promise<Box | null> {
  return page.evaluate((selector) => {
    const wrapper = document.querySelector(selector)?.parentElement;
    if (!wrapper) return null;
    const { left, top, width, height } = wrapper.getBoundingClientRect();
    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
    };
  }, IFRAME);
}

async function enterFullscreen(page: Page) {
  await page.getByRole('button', { name: 'Fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('stage');
}

async function exitFullscreen(page: Page) {
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('http://localhost/fullscreen-host', (route) =>
    route.fulfill({ contentType: 'text/html', body: LAYOUT }),
  );
  await page.goto('http://localhost/fullscreen-host');
  await page.addScriptTag({ content: bundle });
  await expect(page.frameLocator(IFRAME).getByRole('button', { name: 'Left edge' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('player fullscreen with workbench panels open shows the whole page and keeps it clickable', async ({
  page,
}) => {
  // Windowed: the 800x900 pane right of the panels fits 1280x720 at 0.625.
  const windowed = { left: 640, top: 225, width: 800, height: 450 };
  await expect.poll(() => wrapperBox(page)).toEqual(windowed);

  await enterFullscreen(page);
  // Fullscreen: the 1440x900 stage fits 1280x720 at 1.125, letterboxed top and bottom.
  await expect.poll(() => wrapperBox(page)).toEqual({ left: 0, top: 45, width: 1440, height: 810 });
  expect(
    await page.evaluate(
      (s) => document.fullscreenElement!.contains(document.querySelector(s)),
      IFRAME,
    ),
  ).toBe(true);
  // The control at the page's left edge sat where the panels used to clip it.
  const frame = page.frameLocator(IFRAME);
  await frame.getByRole('button', { name: 'Left edge' }).click({ timeout: 5_000 });
  await expect(frame.locator('#count')).toHaveText('1');

  await exitFullscreen(page);
  await expect.poll(() => wrapperBox(page)).toEqual(windowed);
});

test('re-entering fullscreen after a resize follows the new viewport', async ({ page }) => {
  await enterFullscreen(page);
  await expect.poll(() => wrapperBox(page)).toEqual({ left: 0, top: 45, width: 1440, height: 810 });
  await exitFullscreen(page);
  await expect
    .poll(() => wrapperBox(page))
    .toEqual({ left: 640, top: 225, width: 800, height: 450 });

  await page.setViewportSize({ width: 1280, height: 720 });
  // The pane is now 640x720, which fits the page at 0.5.
  const windowed = { left: 640, top: 180, width: 640, height: 360 };
  await expect.poll(() => wrapperBox(page)).toEqual(windowed);

  await enterFullscreen(page);
  await expect.poll(() => wrapperBox(page)).toEqual({ left: 0, top: 0, width: 1280, height: 720 });

  await exitFullscreen(page);
  await expect.poll(() => wrapperBox(page)).toEqual(windowed);
});
