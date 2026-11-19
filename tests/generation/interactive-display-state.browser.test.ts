/**
 * Chromium proof for the interactive display-state rules (#2019).
 *
 * Each case pairs a minimal page that shows the failure with a page built from
 * the prompt's own examples, so a regression in either the browser behavior we
 * rely on or the examples we ship fails here. Syntax checks accept every page
 * below; only layout and rendering tell them apart.
 *
 * Run with `INTERACTIVE_DISPLAY_BROWSER=1`; missing Chromium is then a hard failure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const REQUIRED = process.env.INTERACTIVE_DISPLAY_BROWSER === '1';
const GENERATION = join(process.cwd(), 'packages/@openmaic/generation');

function fencedBlocks(markdown: string, language: string): string[] {
  const fence = new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g');
  return [...markdown.matchAll(fence)].map((match) => match[1]!);
}

function onlyBlock(blocks: string[], marker: string): string {
  const matches = blocks.filter((block) => block.includes(marker));
  expect(matches, marker).toHaveLength(1);
  return matches[0]!;
}

const SNIPPET = readFileSync(join(GENERATION, 'snippets/interactive-display-state.md'), 'utf8');
const HIDDEN_RULE = onlyBlock(fencedBlocks(SNIPPET, 'css'), '[hidden]');

function template(name: string): string {
  return readFileSync(join(GENERATION, `templates/${name}/system.md`), 'utf8');
}

const SIMULATION = template('simulation-content');
const SIMULATION_LAYOUT = onlyBlock(fencedBlocks(SIMULATION, 'html'), 'id="stage"');
const SIMULATION_SCRIPTS = fencedBlocks(SIMULATION, 'javascript');
const RESIZE_EXAMPLE = onlyBlock(SIMULATION_SCRIPTS, 'function resizeCanvas()');
const RESET_EXAMPLE = onlyBlock(SIMULATION_SCRIPTS, 'function resetSimulation()');

/** The Tailwind utilities the layout example uses; tests load no network resources. */
const LAYOUT_UTILITIES = `<style>
  body { margin: 0; }
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .min-h-screen { min-height: 100vh; }
  .w-full { width: 100%; }
  .shrink-0 { flex-shrink: 0; }
  .overflow-auto { overflow: auto; }
  .max-h-\\[40vh\\] { max-height: 40vh; }
  @media (min-width: 768px) {
    .md\\:flex-row { flex-direction: row; }
    .md\\:w-80 { width: 20rem; }
    .md\\:max-h-screen { max-height: 100vh; }
    .md\\:hidden { display: none; }
  }
</style>`;

/**
 * The parts the template leaves to each lesson, filled in with a minimal
 * activity: a level that rises over time, two readouts and the button labels.
 */
const LESSON_PARTS = `
  const LABELS = { start: 'start', pause: 'pause', resume: 'resume', restart: 'restart' };
  function initialQuantities() { return { elapsed: 0, level: 0 }; }
  function advance(s, dt) { s.elapsed += dt; s.level += 20 * dt; }
  function isFinished(s) { return s.level >= 400; }
  function renderReadouts() {
    document.getElementById('elapsed-display').textContent = state.elapsed.toFixed(1);
    document.getElementById('level-display').textContent = state.level.toFixed(1);
  }
  document.getElementById('reset-btn').textContent = 'reset';
  const readouts = document.createElement('p');
  readouts.innerHTML = '<span id="elapsed-display"></span> <span id="level-display"></span>';
  document.getElementById('controls').append(readouts);
`;

/**
 * The simulation template's layout, reset and sizing examples, in the order the
 * template gives them: as one script, as a model usually writes a page, or as
 * two. `before` runs ahead of the examples (for example to break the canvas).
 */
function simulationExamplePage(options: { scripts?: 'one' | 'two'; before?: string } = {}): string {
  const examples =
    options.scripts === 'two'
      ? `<script>${RESET_EXAMPLE}</script>\n<script>${RESIZE_EXAMPLE}</script>`
      : `<script>${RESET_EXAMPLE}\n${RESIZE_EXAMPLE}</script>`;
  return `<!doctype html><html><head>${LAYOUT_UTILITIES}</head>
${SIMULATION_LAYOUT}
<script>
  // The observation projection is the page's own; here it only counts calls.
  window.publications = 0;
  function publishCurrentState() { window.publications++; }
  ${LESSON_PARTS}
  ${options.before ?? ''}
</script>
${examples}
</html>`;
}

async function open(
  context: BrowserContext,
  html: string,
): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(html, { waitUntil: 'load' });
  return { page, errors };
}

async function nextFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, count);
}

describe.skipIf(!REQUIRED)('interactive display-state rules in Chromium', () => {
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

  async function withContext<T>(
    options: { width: number; height: number; deviceScaleFactor?: number },
    run: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
    });
    try {
      return await run(context);
    } finally {
      await context.close();
    }
  }

  describe('hidden layers', () => {
    const overlay = (rule: string) => `<!doctype html>
<style>
  ${rule}
  .area { position: relative; width: 320px; height: 180px; }
  .error-box { position: absolute; inset: 0; display: grid; place-items: center; }
</style>
<div class="area">
  <canvas id="canvas" width="320" height="180"></canvas>
  <div id="error" class="error-box" hidden>Canvas unavailable</div>
  <div id="found" class="error-box" hidden="until-found">Find me</div>
</div>`;

    it('an author display rule shows a hidden layer without the rule', async () => {
      await withContext({ width: 640, height: 360 }, async (context) => {
        const { page } = await open(context, overlay(''));
        expect(await page.locator('#error').evaluate((el) => getComputedStyle(el).display)).toBe(
          'grid',
        );
      });
    });

    it('the rule hides the layer, keeps until-found, and unhiding shows it again', async () => {
      await withContext({ width: 640, height: 360 }, async (context) => {
        const { page } = await open(context, overlay(HIDDEN_RULE));
        const display = (selector: string) =>
          page.locator(selector).evaluate((el) => getComputedStyle(el).display);
        expect(await display('#error')).toBe('none');
        expect(await display('#found')).toBe('grid');
        await page.locator('#error').evaluate((el) => {
          (el as HTMLElement).hidden = false;
        });
        expect(await display('#error')).toBe('grid');
      });
    });

    for (const scripts of ['one', 'two'] as const) {
      it(`the template keeps its error layer hidden on a working canvas (${scripts} script${scripts === 'one' ? '' : 's'})`, async () => {
        await withContext({ width: 1280, height: 720 }, async (context) => {
          const { page, errors } = await open(context, simulationExamplePage({ scripts }));
          expect(errors).toEqual([]);
          expect(
            await page.locator('#canvas-error').evaluate((el) => getComputedStyle(el).display),
          ).toBe('none');
          // The initial state is rendered and published before any user action.
          expect(await page.textContent('#elapsed-display')).toMatch(/^0\.0\b/);
          expect(await page.evaluate('publications')).toBeGreaterThan(0);
        });
      });
    }

    it('the template shows its error layer when the canvas cannot start', async () => {
      await withContext({ width: 1280, height: 720 }, async (context) => {
        const { page, errors } = await open(
          context,
          simulationExamplePage({ before: 'HTMLCanvasElement.prototype.getContext = () => null;' }),
        );
        expect(
          await page.locator('#canvas-error').evaluate((el) => getComputedStyle(el).display),
        ).toBe('grid');
        // The controls keep working without a drawing.
        await page.click('#start-btn');
        await page.click('#reset-btn');
        expect(await page.textContent('#elapsed-display')).toMatch(/^0\.0\b/);
        expect(errors).toEqual([]);
      });
    });

    /** What each listener expects to exist before it runs. */
    const LISTENER_PRELUDE: Record<string, string> = {
      'diagram-content':
        'let revealOrder = ["n1"]; let revealedCount = 1; function renderStep() {}',
    };

    for (const name of ['simulation-content', 'code-content', 'game-content', 'diagram-content']) {
      it(`${name}: REVEAL_ELEMENT shows an element hidden by attribute, class or on SVG`, async () => {
        const listener = onlyBlock(fencedBlocks(template(name), 'javascript'), 'REVEAL_ELEMENT');
        await withContext({ width: 1280, height: 720 }, async (context) => {
          const { page, errors } = await open(
            context,
            `<!doctype html><html><head><style>
  ${HIDDEN_RULE}
  .panel { display: grid; }
  .hidden { display: none; }
</style></head><body>
  <div id="by-attribute" class="panel" hidden>Formula</div>
  <div id="by-class" class="panel hidden">Hint</div>
  <svg width="100" height="40"><g id="svg-label" hidden><text x="0" y="20">Label</text></g></svg>
  <script>${LISTENER_PRELUDE[name] ?? ''}</script>
  <script>${listener}</script>
</body></html>`,
          );
          for (const [target, shown] of [
            ['#by-attribute', 'grid'],
            ['#by-class', 'grid'],
            ['#svg-label', 'inline'],
          ] as const) {
            expect(await page.locator(target).evaluate((el) => getComputedStyle(el).display)).toBe(
              'none',
            );
            await page.evaluate((selector) => {
              window.postMessage({ type: 'REVEAL_ELEMENT', target: selector }, '*');
            }, target);
            await expect
              .poll(() => page.locator(target).evaluate((el) => getComputedStyle(el).display))
              .toBe(shown);
          }
          expect(errors).toEqual([]);
        });
      });
    }
  });

  describe('canvas sizing', () => {
    it('a canvas in the flow of the element it measures keeps growing', async () => {
      await withContext({ width: 1280, height: 720 }, async (context) => {
        const { page } = await open(
          context,
          `<!doctype html>
<style>
  .row { display: flex; align-items: stretch; }
  .controls { width: 160px; flex: 0 0 160px; height: 300px; }
  .area { position: relative; flex: 1; min-width: 0; min-height: 300px; padding: 1px; box-sizing: border-box; }
  canvas { display: block; width: 100%; height: 100%; }
</style>
<div class="row"><div class="controls"></div><div class="area"><canvas></canvas></div></div>
<script>
  const canvas = document.querySelector('canvas');
  const area = canvas.parentElement;
  const observer = new ResizeObserver(resize);
  function resize() {
    if (area.clientHeight > 1024) { observer.disconnect(); return; }
    canvas.width = Math.round(canvas.clientWidth * 2);
    canvas.height = Math.round(area.clientHeight * 2);
  }
  observer.observe(area);
  resize();
</script>`,
        );
        // Each frame adds a little; measure over a fixed number of frames so the
        // check does not depend on the display's refresh rate.
        const height = () => page.evaluate(() => document.querySelector('.area')!.clientHeight);
        const start = await height();
        await nextFrames(page, 30);
        const middle = await height();
        await nextFrames(page, 30);
        const end = await height();
        expect(middle).toBeGreaterThan(start + 20);
        expect(end).toBeGreaterThan(middle + 20);
      });
    });

    const viewports = [
      { width: 1280, height: 720, deviceScaleFactor: 1 },
      { width: 1280, height: 720, deviceScaleFactor: 2 },
      { width: 375, height: 812, deviceScaleFactor: 3 },
    ];

    for (const viewport of viewports) {
      it(`the template's canvas settles at ${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}x`, async () => {
        await withContext(viewport, async (context) => {
          const { page, errors } = await open(context, simulationExamplePage());
          const size = () =>
            page.evaluate(() => {
              const stage = document.getElementById('stage')!;
              const canvas = document.getElementById('canvas') as HTMLCanvasElement;
              return {
                stage: [stage.clientWidth, stage.clientHeight],
                bitmap: [canvas.width, canvas.height],
              };
            });
          const expected = async () => {
            const { stage } = await size();
            return stage.map((side) => Math.round(side * viewport.deviceScaleFactor));
          };

          await expect.poll(async () => (await size()).bitmap).toEqual(await expected());
          const settled = await size();
          await nextFrames(page, 30);
          expect(await size()).toEqual(settled);
          if (viewport.width >= 768) {
            // Side by side, the stage fills the frame's height.
            expect(settled.stage[1]).toBe(viewport.height);
          } else {
            expect(settled.stage[1]).toBeGreaterThanOrEqual(260);
            expect(settled.stage[1]).toBeLessThanOrEqual(viewport.height);
          }
          // Drawing happens in CSS pixels.
          expect(await page.evaluate('ctx.getTransform().a')).toBe(viewport.deviceScaleFactor);

          // A viewport change settles at the new stage size, then stays.
          await page.setViewportSize({ width: viewport.width - 120, height: viewport.height - 80 });
          await expect.poll(async () => (await size()).bitmap).toEqual(await expected());
          const resized = await size();
          await nextFrames(page, 30);
          expect(await size()).toEqual(resized);
          expect(errors).toEqual([]);
        });
      });
    }
  });

  describe('reset readouts', () => {
    it('resetting state without rendering leaves the previous readout', async () => {
      await withContext({ width: 640, height: 360 }, async (context) => {
        const { page } = await open(
          context,
          `<!doctype html>
<output id="time">0.0</output>
<button id="run" onclick="state.time = 40.7; render()">Run</button>
<button id="reset" onclick="state.time = 0">Reset</button>
<script>
  const state = { time: 0 };
  function render() { document.getElementById('time').textContent = state.time.toFixed(1); }
</script>`,
        );
        await page.click('#run');
        await page.click('#reset');
        expect(await page.evaluate('state.time')).toBe(0);
        expect(await page.textContent('#time')).toBe('40.7');
      });
    });

    it("the template's reset restores every readout and label on each path", async () => {
      await withContext({ width: 1280, height: 720 }, async (context) => {
        const { page, errors } = await open(context, simulationExamplePage());
        const readouts = () =>
          page.evaluate(() => ({
            time: document.getElementById('elapsed-display')!.textContent,
            level: document.getElementById('level-display')!.textContent,
            button: document.getElementById('start-btn')!.textContent,
          }));
        const initial = await readouts();
        expect(initial.time).toMatch(/^0\.0\b/);

        const run = async () => {
          await page.click('#start-btn');
          await expect.poll(async () => (await readouts()).time).not.toBe(initial.time);
          const running = await readouts();
          expect(running.level).not.toBe(initial.level);
          expect(running.button).not.toBe(initial.button);
        };
        const frozen = async () => {
          expect(await readouts()).toEqual(initial);
          await nextFrames(page, 10);
          expect(await readouts()).toEqual(initial);
        };

        // Start then Reset, twice.
        for (let i = 0; i < 2; i++) {
          await run();
          await page.click('#reset-btn');
          await frozen();
        }

        // Start, Pause, Reset.
        await run();
        const running = await readouts();
        await page.click('#start-btn');
        const paused = await readouts();
        expect(paused.time).not.toBe(initial.time);
        expect(paused.button).not.toBe(initial.button);
        expect(paused.button).not.toBe(running.button);
        await page.click('#reset-btn');
        await frozen();

        // An ended run: the main button resets it.
        await run();
        // As the loop does when the run reaches its end: stop the frame, then end.
        await page.evaluate('cancelAnimationFrame(frameId); onSimulationEnd()');
        expect((await readouts()).button).not.toBe(initial.button);
        await page.click('#start-btn');
        await frozen();

        // Every render publishes, reset included.
        const before = await page.evaluate('publications');
        await page.click('#reset-btn');
        expect(await page.evaluate('publications')).toBe(Number(before) + 1);
        expect(errors).toEqual([]);
      });
    });
  });
});
