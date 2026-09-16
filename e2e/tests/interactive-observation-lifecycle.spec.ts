import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
type TestWindow = Window & {
  IframeUtils: typeof import('../../lib/utils/iframe');
  Bridge: typeof import('../../lib/interactive/observation-bridge');
  identity: import('../../lib/interactive/observation-bridge').ObservationIdentity;
  session: ReturnType<
    typeof import('../../lib/interactive/observation-bridge').createObservationSession
  >;
  ready: Promise<unknown>;
  f: HTMLIFrameElement;
};
const require = createRequire(process.cwd() + '/package.json');
const { buildSync } = require(
  createRequire(require.resolve('tsx/package.json')).resolve('esbuild'),
);
const bundle = buildSync({
  entryPoints: ['lib/interactive/observation-bridge.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Bridge',
}).outputFiles[0].text;
const patchBundle = buildSync({
  entryPoints: ['lib/utils/iframe.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'IframeUtils',
}).outputFiles[0].text;
const graph = {
  objects: [
    { id: 'o', label: 'Object', facts: [{ key: 'v', label: 'Value', status: 'known', value: 7 }] },
  ],
  relations: { status: 'complete', items: [] },
  missing: [],
};
const observation = {
  version: 1,
  scope: { id: 'experiment', label: 'Test' },
  current: { revision: 0, updatedAt: 1, graph },
  rendered: { status: 'known', basedOnRevision: 0, renderedAt: 1, graph },
};
const html = `<main id="experiment"><script type="application/json" data-maic-observation>${JSON.stringify(observation)}</script></main>`;
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.route('http://localhost/observation-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
  );
  await page.goto('http://localhost/observation-test');
  await page.evaluate(
    bundle +
      `;window.Bridge=Bridge;window.f=document.createElement('iframe');f.sandbox='allow-scripts';window.identity={sceneId:'s',scopeId:'experiment',documentId:crypto.randomUUID()};window.ready=new Promise(resolve=>f.onload=resolve);f.srcdoc=Bridge.withObservationResponder(${JSON.stringify(html)},identity);document.body.replaceChildren(f);`,
  );
  await page.evaluate(
    `ready.then(()=>{window.session=Bridge.createObservationSession(f,identity)})`,
  );
});
test('actual serialized responder reads without business side effects and rejects replacement', async ({
  page,
}) => {
  const value = await page.evaluate('session.capture()');
  expect(value).toHaveProperty('status', 'available');
  const frame = page.frames().find((f) => f.parentFrame())!;
  await frame.locator('#experiment').evaluate((el) => el.replaceWith(el.cloneNode(true)));
  expect(await page.evaluate('session.capture()')).toMatchObject({
    status: 'unavailable',
    reason: 'scope-changed',
  });
});
test('timeout/cancel remove listeners; late old reply cannot overwrite or satisfy next request', async ({
  page,
}) => {
  await page.evaluate(
    `window.delayed=[];window.block=(e)=>{if(e.data?.type==='maic:observation:result:v1'){delayed.push(e.data);e.stopImmediatePropagation()}};addEventListener('message',block,true)`,
  );
  expect(await page.evaluate('session.capture({timeoutMs:50})')).toMatchObject({
    reason: 'timeout',
  });
  const frame = page.frames().find((f) => f.parentFrame())!;
  await frame.locator('script[data-maic-observation]').evaluate((el) => {
    const data = JSON.parse(el.textContent!);
    data.current.graph.objects[0].facts[0].value = 19;
    el.textContent = JSON.stringify(data);
  });
  await page.evaluate(
    `removeEventListener('message',block,true);window.next=session.capture();for(const data of delayed)dispatchEvent(new MessageEvent('message',{source:f.contentWindow,data}));`,
  );
  expect(await page.evaluate('next')).toMatchObject({
    status: 'available',
    observation: { current: { graph: { objects: [{ facts: [{ value: 19 }] }] } } },
  });
  await page.evaluate(
    `addEventListener('message',block,true);window.abort=new AbortController();window.cancelled=session.capture({signal:abort.signal});abort.abort();`,
  );
  expect(await page.evaluate('cancelled')).toMatchObject({ reason: 'cancelled' });
});
test('reload/dispose invalidate pending requests and old sessions; changed source cannot answer', async ({
  page,
}) => {
  await page.evaluate(
    `window.pending=session.capture();session.dispose();f.srcdoc='<main>New document without interface</main>'`,
  );
  expect(await page.evaluate('pending')).toMatchObject({ reason: 'document-changed' });
  expect(await page.evaluate('session.capture()')).toMatchObject({ reason: 'document-changed' });
});
test('spurious reply from another window is ignored; no interface is explicit', async ({
  page,
}) => {
  await page.evaluate(
    `window.request=session.capture();dispatchEvent(new MessageEvent('message',{source:window,data:{type:'maic:observation:result:v1',requestId:'fake',...identity,raw:'{}'}}))`,
  );
  expect(await page.evaluate('request')).toHaveProperty('status', 'available');
  await page
    .frames()
    .find((f) => f.parentFrame())!
    .locator('script[data-maic-observation]')
    .evaluate((el) => el.remove());
  expect(await page.evaluate('session.capture()')).toMatchObject({
    status: 'unavailable',
    reason: 'no-interface',
  });
});

test('actual iframe navigation invalidates an in-flight read without caller disposal', async ({
  page,
}) => {
  await page.evaluate(
    `addEventListener('message',e=>{if(e.data?.type==='maic:observation:result:v1')e.stopImmediatePropagation()},true);window.pending=session.capture();window.reloaded=new Promise(resolve=>f.onload=resolve);f.srcdoc='<main>replacement document</main>'`,
  );
  await page.evaluate('reloaded');
  expect(await page.evaluate('pending')).toMatchObject({
    status: 'unavailable',
    reason: 'document-changed',
  });
  expect(await page.evaluate('session.capture()')).toMatchObject({
    status: 'unavailable',
    reason: 'document-changed',
  });
});

// These authored strings must not become insertion locations.
for (const ending of ['</BoDy   ></html>', '']) {
  test('reader preserves script/comment/attribute tag text; ending=' + ending, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const source =
      '<!doctype html><html><head></head><body>' +
      '<!-- </body> --><main id="experiment" title="</body>"></main>' +
      '<script>const closingTag = "</body>";' +
      'const outlet=document.createElement("script");outlet.type="application/json";' +
      'outlet.setAttribute("data-maic-observation","");' +
      'outlet.textContent=' +
      JSON.stringify(JSON.stringify(observation)) +
      ';' +
      'document.querySelector("#experiment").append(outlet);</script>' +
      ending;
    await page.evaluate(patchBundle + ';window.IframeUtils=IframeUtils');
    const patched = await page.evaluate(
      (source) => (window as unknown as TestWindow).IframeUtils.patchHtmlForIframe(source),
      source,
    );
    // Compare the existing platform patch alone with the additional reader.
    for (const reader of [false, true]) {
      const output = await page.evaluate(
        ({ patched, reader }) => {
          const w = window as unknown as TestWindow;
          return reader ? w.Bridge.withObservationResponder(patched, w.identity) : patched;
        },
        { patched, reader },
      );
      if (reader) {
        expect(output.replace(/<script data-maic-observation-reader>[\s\S]*?<\/script>/, '')).toBe(
          patched,
        );
      }
      await page.evaluate((output) => {
        const w = window as unknown as TestWindow;
        w.session.dispose();
        w.ready = new Promise((resolve) => (w.f.onload = resolve));
        w.f.srcdoc = output;
      }, output);
      await page.evaluate('ready');
      const frame = page.frames().find((f) => f.parentFrame())!;
      expect(
        JSON.parse((await frame.locator('script[data-maic-observation]').textContent()) || '{}'),
      ).toMatchObject({ current: { graph: { objects: [{ facts: [{ value: 7 }] }] } } });
      if (reader) {
        await page.evaluate('window.session=Bridge.createObservationSession(f,identity)');
        expect(await page.evaluate('session.capture()')).toMatchObject({
          status: 'available',
          observation: { current: { graph: { objects: [{ facts: [{ value: 7 }] }] } } },
        });
      }
    }
    expect(errors).toEqual([]);
  });
}

// Execute the publication example that is actually included in generation prompts.
const publicationExample = readFileSync(
  'packages/@openmaic/generation/snippets/interactive-observation.md',
  'utf8',
).match(/```javascript\n(function publishState[\s\S]*?)```/)![1];
for (const failure of ['cycle', 'bigint', 'oversize', 'undefined', 'schema'] as const) {
  test(`prompt publication ${failure} never returns previously known state`, async ({ page }) => {
    const frame = page.frames().find((frame) => frame !== page.mainFrame())!;
    await frame.addScriptTag({ content: publicationExample });
    await frame.evaluate((observation) => {
      (window as unknown as { publishState(value: unknown): void }).publishState(observation);
    }, observation);
    expect(await page.evaluate('session.capture()')).toMatchObject({
      status: 'available',
      observation: { current: { graph: { objects: [{ facts: [{ value: 7 }] }] } } },
    });
    const publication = await frame.evaluate(
      ({ observation, failure }) => {
        const publish = (window as unknown as { publishState(value: unknown): void }).publishState;
        const invalid = structuredClone(observation) as unknown as Record<string, unknown>;
        if (failure === 'cycle') invalid.loop = invalid;
        if (failure === 'bigint') invalid.value = BigInt(1);
        if (failure === 'oversize') invalid.value = 'x'.repeat(32769);
        if (failure === 'schema') invalid.version = 999;
        let threw = false;
        try {
          publish(failure === 'undefined' ? undefined : invalid);
        } catch {
          threw = true;
        }
        return { threw, outletPresent: !!document.querySelector('[data-maic-observation]') };
      },
      { observation, failure },
    );
    // The prompt helper handles publication failures; the actual collector owns schema validation.
    expect(publication).toEqual({
      threw: failure !== 'schema',
      outletPresent: failure === 'schema',
    });
    expect(await page.evaluate('session.capture()')).toMatchObject({
      status: 'unavailable',
      reason: failure === 'schema' ? 'invalid-data' : 'no-interface',
    });
  });
}
