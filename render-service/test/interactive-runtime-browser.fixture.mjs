import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedInteractiveLibraries } from '../src/hosted-interactive-libraries.ts';
import { ChromiumPreviewRenderer } from '../src/preview-renderer.ts';

const renderer = new ChromiumPreviewRenderer();
const deadlineMs = 3_000;
const actions = [
  { id: 'state', type: 'widget_setState', state: { ready: true } },
  { id: 'speech', type: 'speech', text: 'Look at the highlighted part.' },
  { id: 'first', type: 'widget_reveal', target: '#first' },
  { id: 'second', type: 'widget_reveal', target: '#second', content: 'The second part' },
];

function check(script, replay = []) {
  return checkHtml(renderer, `<!doctype html><script>${script}</script>`, replay);
}

function checkHtml(renderer, html, replay = []) {
  return renderer.checkInteractiveRuntime({
    scene: {
      id: 'test-scene',
      stageId: 'test-stage',
      order: 1,
      title: 'Test scene',
      type: 'interactive',
      content: { type: 'interactive', html },
      actions: replay,
    },
    stage: { id: 'test-stage', name: 'Test stage' },
    viewport: { width: 640, height: 360, deviceScaleFactor: 1 },
    signal: AbortSignal.timeout(deadlineMs),
    deadlineMs,
  });
}

assert.deepEqual(
  await check(`
    console.error('Console only');
    Promise.reject('Rejected during load');
    throw new ReferenceError('Missing setup');
  `),
  [
    { phase: 'load', message: 'ReferenceError: Missing setup' },
    { phase: 'load', message: 'Rejected during load' },
  ],
);
assert.deepEqual(
  await check(
    `
    let ready = false;
    let first = false;
    window.addEventListener('message', ({ data, source }) => {
      if (source !== parent) return;
      if (data.type === 'SET_WIDGET_STATE') ready = data.state.ready;
      if (data.type === 'REVEAL_ELEMENT' && data.target === '#first') first = ready;
      if (data.type === 'REVEAL_ELEMENT' && data.target === '#second' && first) {
        setTimeout(() => Promise.reject(new TypeError(data.content)), 15);
      }
    });
  `,
    actions,
  ),
  [
    {
      phase: 'action',
      actionIndex: 3,
      actionType: 'REVEAL_ELEMENT',
      message: 'TypeError: The second part',
    },
  ],
);
assert.deepEqual(
  await check(
    `
  console.error('Console only');
  Promise.reject(new Error('Handled')).catch(() => {});
  window.addEventListener('message', () => console.error('Console only during replay'));
`,
    actions,
  ),
  [],
);

const directory = await mkdtemp(join(tmpdir(), 'runtime-library-browser-'));
try {
  const classic = 'chart.js@4.4.8/dist';
  const modules = 'three@0.160.0/build';
  const css = 'katex@0.16.38/dist';
  for (const assetDir of [classic, modules, css]) {
    await mkdir(join(directory, assetDir), { recursive: true });
  }
  await writeFile(join(directory, classic, 'chart.umd.js'), 'globalThis.chartFixture = 17;');
  await writeFile(
    join(directory, modules, 'three.module.js'),
    'export { fixture } from "./dep.js";',
  );
  await writeFile(join(directory, modules, 'dep.js'), 'export const fixture = 23;');
  await writeFile(join(directory, css, 'katex.min.css'), 'body { color: rgb(1, 2, 3); }');

  const mirrorBase = 'https://assets.example.test/interactive';
  const withLibraries = new ChromiumPreviewRenderer({
    interactiveLibraries: new HostedInteractiveLibraries(directory, mirrorBase),
  });
  assert.deepEqual(
    await checkHtml(
      withLibraries,
      `
      <!doctype html>
      <link rel="stylesheet" href="/vendor/interactive/${css}/katex.min.css">
      <script src="/vendor/interactive/${classic}/chart.umd.js"></script>
      <script type="importmap">
        {"imports": {"three": "${mirrorBase}/${modules}/three.module.js"}}
      </script>
      <script type="module">
        import { fixture } from 'three';
        globalThis.moduleFixture = fixture;
      </script>
      <script>
        addEventListener('load', () => {
          if (globalThis.chartFixture !== 17) throw new Error('Classic script did not load');
          if (globalThis.moduleFixture !== 23) throw new Error('Module graph did not load');
          if (getComputedStyle(document.body).color !== 'rgb(1, 2, 3)') {
            throw new Error('Stylesheet did not load');
          }
        });
      </script>
      <body>Widget</body>
    `,
    ),
    [],
  );

  const missingDirectory = new ChromiumPreviewRenderer({
    interactiveLibraries: new HostedInteractiveLibraries(join(directory, 'missing')),
  });
  assert.deepEqual(
    await checkHtml(
      missingDirectory,
      `
      <!doctype html><script src="/vendor/interactive/${classic}/chart.umd.js"></script>
    `,
    ),
    [{ phase: 'load', message: `Failed to load interactive library: ${classic}/chart.umd.js` }],
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('Interactive runtime checks verified');
