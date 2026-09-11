// Run with node --import tsx so callbacks come from the production transform.
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { buildSlideClientBundle, ChromiumPreviewRenderer } from '../src/preview-renderer.ts';

const type = process.argv[2];
assert.ok(type === 'slide' || type === 'interactive');
const viewport = { width: 640, height: 360, deviceScaleFactor: 1 };
const canvas = {
  id: 'canvas',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#111', fontName: 'sans-serif' },
  elements: [],
};
const scene = {
  id: 'boundary-scene',
  stageId: 'stage',
  order: 1,
  title: 'Preview',
  type,
  content:
    type === 'slide'
      ? { type, canvas }
      : { type, html: '<!doctype html><html><body>Preview</body></html>' },
  actions: [],
};
const calls = [];

function browserContext(name) {
  let settled = 0;
  const context = createContext({
    document: {
      readyState: 'complete',
      fonts: { ready: Promise.resolve() },
      images: [],
      documentElement: {},
      body: {
        getAttribute(attribute) {
          assert.equal(attribute, 'data-scene-id');
          assert.equal(name, 'page');
          calls.push('scene-id');
          return scene.id;
        },
      },
    },
    location: { href: name === 'frame' ? 'about:srcdoc' : 'about:blank' },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    MutationObserver: class {
      observe() {}
      disconnect() {
        settled += 1;
      }
    },
  });
  runInContext('window = globalThis', context);

  // Serialize source and arguments, never call the original function in Node.
  // No module-scoped helpers (including __name) are supplied to the VM.
  const evaluate = async (callback, ...args) => {
    calls.push(`${name}.evaluate`);
    const source =
      typeof callback === 'string'
        ? callback
        : `(${callback.toString()})(...${JSON.stringify(args)})`;
    return await runInContext(source, context);
  };
  return {
    context,
    evaluate,
    async waitForFunction(callback, _options, ...args) {
      calls.push(`${name}.waitForFunction`);
      assert.equal(await evaluate(callback, ...args), true);
    },
    assertSettled(expected) {
      assert.equal(settled, expected, `${name} asset wait`);
    },
  };
}

const pageWorld = browserContext('page');
const frameWorld = browserContext('frame');
const mountScript = 'window.__OPENMAIC_PREVIEW_MOUNTED__ = true;';
await buildSlideClientBundle(async () => ({ outputFiles: [{ text: mountScript }] }));
const screenshot = Buffer.from('test screenshot');
const page = {
  evaluate: pageWorld.evaluate,
  waitForFunction: pageWorld.waitForFunction,
  async setViewport(value) {
    assert.deepEqual(value, viewport);
  },
  async setContent(html) {
    assert.ok(html.includes(`data-scene-id="${scene.id}"`));
  },
  on() {},
  off() {},
  async addScriptTag({ content }) {
    assert.equal(content, mountScript);
    // This observes the result of the real slide/viewport injection callback.
    assert.equal(
      JSON.stringify(pageWorld.context.__OPENMAIC_PREVIEW_PROPS__),
      JSON.stringify({ slide: canvas, viewport }),
    );
    runInContext(content, pageWorld.context);
  },
  async waitForSelector(selector) {
    assert.equal(selector, 'iframe');
    return { contentFrame: async () => frameWorld };
  },
  async screenshot() {
    calls.push('screenshot');
    pageWorld.assertSettled(type === 'slide' ? 1 : 0);
    frameWorld.assertSettled(type === 'interactive' ? 1 : 0);
    return screenshot;
  },
};

// The launcher is injected; no browser executable is used or downloaded.
process.env.PRODUCER_HEADLESS_SHELL_PATH = '/unused/browser-boundary-test';
const renderer = new ChromiumPreviewRenderer({
  browserLauncher: {
    launch: async () => ({
      newPage: async () => page,
      close: async () => {
        calls.push('close');
      },
    }),
  },
});
const result = await renderer.render({
  scene,
  stage: { id: 'stage', name: 'Course' },
  viewport,
  signal: AbortSignal.timeout(10_000),
  deadlineMs: 10_000,
});
assert.deepEqual(Buffer.from(result), screenshot);
assert.deepEqual(
  calls,
  type === 'slide'
    ? [
        'page.evaluate',
        'page.waitForFunction',
        'page.evaluate',
        'page.evaluate',
        'scene-id',
        'page.evaluate',
        'screenshot',
        'close',
      ]
    : [
        'page.evaluate',
        'scene-id',
        'frame.waitForFunction',
        'frame.evaluate',
        'frame.evaluate',
        'screenshot',
        'close',
      ],
);
console.log(`${type} callbacks verified`);
