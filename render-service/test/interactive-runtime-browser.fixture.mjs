import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostedInteractiveLibraries } from '../src/hosted-interactive-libraries.ts';
import { ChromiumPreviewRenderer } from '../src/preview-renderer.ts';
import { RenderCoordinator } from '../src/render-coordinator.ts';
import { Semaphore } from '../src/semaphore.ts';
import {
  createMemoryArtifactStore,
  createMemoryJobStore,
  succeedingExecutor,
} from './support/fakes.ts';

process.env.RENDER_SERVICE_NO_LISTEN = 'true';
const { createApp } = await import('../src/main.ts');

function runtimeApp(renderer) {
  const jobs = createMemoryJobStore();
  const { store: artifacts } = createMemoryArtifactStore();
  return createApp({
    jobs,
    artifacts,
    coordinator: new RenderCoordinator(succeedingExecutor, jobs, artifacts),
    extractionGate: new Semaphore(1),
    interactiveRuntimeCheck: renderer?.checkInteractiveRuntime.bind(renderer),
    onEvent() {},
  });
}

const app = runtimeApp();
const actions = [
  { id: 'state', type: 'widget_setState', state: { ready: true } },
  { id: 'speech', type: 'speech', text: 'Look at the highlighted part.' },
  { id: 'first', type: 'widget_reveal', target: '#first' },
  { id: 'second', type: 'widget_reveal', target: '#second', content: 'The second part' },
];

function check(script, replay = []) {
  return checkHtml(app, `<!doctype html><script>${script}</script>`, replay);
}

async function checkHtml(app, html, replay = []) {
  const payload = {
    version: 1,
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
  };
  const response = await app.request('/interactive-runtime-check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result.errors;
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
  const katex = 'katex@0.16.38/dist';
  for (const assetDir of [classic, modules, `${katex}/contrib`]) {
    await mkdir(join(directory, assetDir), { recursive: true });
  }
  await writeFile(join(directory, classic, 'chart.umd.js'), 'globalThis.chartFixture = 17;');
  await writeFile(
    join(directory, modules, 'three.module.js'),
    'export { fixture } from "./dep.js";',
  );
  await writeFile(join(directory, modules, 'dep.js'), 'export const fixture = 23;');
  await writeFile(join(directory, katex, 'katex.min.css'), 'body { color: rgb(1, 2, 3); }');
  await writeFile(
    join(directory, katex, 'katex.min.js'),
    'window.katex = { render(tex, target) { target.textContent = tex; } };',
  );
  await writeFile(
    join(directory, katex, 'contrib/auto-render.min.js'),
    'window.renderMathInElement = () => {};',
  );

  const mirrorBase = 'https://assets.example.test/interactive';
  const withLibraries = runtimeApp(
    new ChromiumPreviewRenderer({
      interactiveLibraries: new HostedInteractiveLibraries(directory, mirrorBase),
    }),
  );
  assert.deepEqual(
    await checkHtml(
      withLibraries,
      `
      <!doctype html>
      <link rel="stylesheet" href="/vendor/interactive/${katex}/katex.min.css">
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
  assert.deepEqual(
    await checkHtml(
      withLibraries,
      `<!doctype html><div id="math"></div><script>
        const target = document.getElementById('math');
        katex.render('x^2', target);
        if (target.textContent !== 'x^2') throw new Error('Hosted KaTeX did not render');
      </script>`,
    ),
    [],
  );
  assert.deepEqual(
    await checkHtml(
      withLibraries,
      `<!doctype html><script src="//unpkg.com/katex@0.16.9/dist/katex.min.js"></script><script>
        if (typeof window.katex?.render !== 'function') throw new Error('Hosted KaTeX did not load');
      </script>`,
    ),
    [],
  );

  const missingDirectory = runtimeApp(
    new ChromiumPreviewRenderer({
      interactiveLibraries: new HostedInteractiveLibraries(join(directory, 'missing')),
    }),
  );
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
