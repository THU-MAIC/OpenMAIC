import assert from 'node:assert/strict';
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
  return renderer.checkInteractiveRuntime({
    scene: {
      id: 'test-scene',
      stageId: 'test-stage',
      order: 1,
      title: 'Test scene',
      type: 'interactive',
      content: { type: 'interactive', html: `<!doctype html><script>${script}</script>` },
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
console.log('Interactive runtime checks verified');
