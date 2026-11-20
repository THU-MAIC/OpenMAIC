import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
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
const observation = {
  summary: 'The value is 7.',
  state: { value: 7 },
  rendered: { value: 7 },
};
const html = `<main id="experiment"><script type="application/json" data-maic-observation>${JSON.stringify(observation)}</script></main>`;
test.describe('Observation responder lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
    await page.route('http://localhost/observation-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body></body></html>',
      }),
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
      data.state.value = 19;
      el.textContent = JSON.stringify(data);
    });
    await page.evaluate(
      `removeEventListener('message',block,true);window.next=session.capture();for(const data of delayed)dispatchEvent(new MessageEvent('message',{source:f.contentWindow,data}));`,
    );
    expect(await page.evaluate('next')).toMatchObject({
      status: 'available',
      observation: { state: { value: 19 } },
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

  test('a legacy page with no scope reports no-interface; removing a declared scope reports scope-changed', async ({
    page,
  }) => {
    expect(await page.evaluate('session.capture()')).toHaveProperty('status', 'available');
    const frame = page.frames().find((f) => f.parentFrame())!;
    await frame.locator('#experiment').evaluate((el) => el.remove());
    expect(await page.evaluate('session.capture()')).toMatchObject({
      status: 'unavailable',
      reason: 'scope-changed',
    });

    await page.evaluate(patchBundle + ';window.IframeUtils=IframeUtils;');
    await page.evaluate(async () => {
      const w = window as unknown as TestWindow;
      w.session.dispose();
      const ready = new Promise<void>((resolve) => {
        w.f.onload = () => resolve();
      });
      w.f.srcdoc = w.IframeUtils.patchHtmlForIframe('<main>Legacy activity</main>', w.identity);
      await ready;
      w.session = w.Bridge.createObservationSession(w.f, w.identity);
    });
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
    test(
      'reader preserves script/comment/attribute tag text; ending=' + ending,
      async ({ page }) => {
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
            expect(
              output.replace(/<script data-maic-observation-reader>[\s\S]*?<\/script>/, ''),
            ).toBe(patched);
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
            JSON.parse(
              (await frame.locator('script[data-maic-observation]').textContent()) || '{}',
            ),
          ).toMatchObject({ state: { value: 7 } });
          if (reader) {
            await page.evaluate('window.session=Bridge.createObservationSession(f,identity)');
            expect(await page.evaluate('session.capture()')).toMatchObject({
              status: 'available',
              observation: { state: { value: 7 } },
            });
          }
        }
        expect(errors).toEqual([]);
      },
    );
  }

  test('a report that defeats recursion settles the sample instead of hanging it', async ({
    page,
  }) => {
    // Free-form JSON means a page can publish something that every later step over
    // it — stringify, clone, freeze — cannot walk. The sample must still finish: a
    // send waits on it before the question goes out, so a pending promise would
    // hang the classroom rather than degrade the answer.
    const frame = page.frames().find((frame) => frame !== page.mainFrame())!;
    await frame.evaluate(() => {
      const nested = '['.repeat(10_000) + '1' + ']'.repeat(10_000);
      const raw = `{"summary":"deep","state":${nested}}`;
      document.querySelector('script[data-maic-observation]')!.textContent = raw;
      return new TextEncoder().encode(raw).length;
    });
    const settled = await page.evaluate(
      `Promise.race([
       session.capture(),
       new Promise((resolve) => setTimeout(() => resolve('HUNG'), 4000)),
     ])`,
    );
    expect(settled).not.toBe('HUNG');
    expect(settled).toMatchObject({ status: 'unavailable' });
  });

  // Execute the publication example that is actually included in generation prompts.
  const publicationExample = readFileSync(
    'packages/@openmaic/generation/snippets/interactive-observation.md',
    'utf8',
  ).match(/```javascript\n(function publishState[\s\S]*?)```/)![1];
  for (const failure of ['cycle', 'bigint', 'oversize', 'undefined'] as const) {
    test(`prompt publication ${failure} never returns previously known state`, async ({ page }) => {
      const frame = page.frames().find((frame) => frame !== page.mainFrame())!;
      await frame.addScriptTag({ content: publicationExample });
      await frame.evaluate((observation) => {
        (window as unknown as { publishState(value: unknown): void }).publishState(observation);
      }, observation);
      expect(await page.evaluate('session.capture()')).toMatchObject({
        status: 'available',
        observation: { state: { value: 7 } },
      });
      const publication = await frame.evaluate(
        ({ observation, failure }) => {
          const publish = (window as unknown as { publishState(value: unknown): void })
            .publishState;
          const invalid = structuredClone(observation) as unknown as Record<string, unknown>;
          if (failure === 'cycle') invalid.loop = invalid;
          if (failure === 'bigint') invalid.value = BigInt(1);
          if (failure === 'oversize') invalid.value = 'x'.repeat(32769);

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
      // Failed publication must remove the previously published state.
      expect(publication).toEqual({
        threw: true,
        outletPresent: false,
      });
      expect(await page.evaluate('session.capture()')).toMatchObject({
        status: 'unavailable',
        reason: 'no-interface',
      });
    });
  }

  for (const value of [[{ density: 1400 }], 'density is 1400', 1400, false, null]) {
    test(`reader delivers JSON value ${JSON.stringify(value)} unchanged`, async ({ page }) => {
      const frame = page.frames().find((frame) => frame !== page.mainFrame())!;
      await frame.addScriptTag({ content: publicationExample });
      await frame.evaluate((value) => {
        (window as unknown as { publishState(value: unknown): void }).publishState(value);
      }, value);
      expect(await page.evaluate('session.capture()')).toMatchObject({
        status: 'available',
        observation: value,
      });
    });
  }

  for (const creation of ['DOMContentLoaded', 'after an empty read'] as const) {
    test(`reads a scope created on ${creation} and still rejects later replacement`, async ({
      page,
    }) => {
      await page.evaluate(patchBundle + ';window.IframeUtils=IframeUtils;');
      await page.evaluate(
        async ({ creation, html }) => {
          const w = window as unknown as TestWindow;
          w.session.dispose();
          const ready = new Promise<void>((resolve) => {
            w.f.onload = () => resolve();
          });
          const source =
            creation === 'DOMContentLoaded'
              ? '<script>document.addEventListener("DOMContentLoaded",()=>document.body.insertAdjacentHTML("afterbegin",' +
                JSON.stringify(html).replace(/</g, '\\u003c') +
                '));<\/script>'
              : '<main>Waiting for activity</main>';
          w.f.srcdoc = w.IframeUtils.patchHtmlForIframe(source, w.identity);
          await ready;
          w.session = w.Bridge.createObservationSession(w.f, w.identity);
        },
        { creation, html },
      );
      const frame = page.frames().find((f) => f.parentFrame())!;
      if (creation === 'after an empty read') {
        expect(await page.evaluate('session.capture()')).toMatchObject({ reason: 'no-interface' });
        await frame
          .locator('body')
          .evaluate((el, html) => el.insertAdjacentHTML('afterbegin', html), html);
      }
      expect(await page.evaluate('session.capture()')).toMatchObject({
        status: 'available',
        observation,
      });
      await frame.locator('#experiment').evaluate((el) => el.replaceWith(el.cloneNode(true)));
      expect(await page.evaluate('session.capture()')).toMatchObject({ reason: 'scope-changed' });
    });
  }
});

const path = 'components/scene-renderers/InteractiveIframeHost.tsx';
const source = ts.createSourceFile(
  path,
  readFileSync(path, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
// Execute the actual private component, stubbing only surrounding stores and presentation dependencies.
const component = source.statements
  .find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'PooledIframe')!
  .getText(source);
const activityHtml = (declared: boolean) =>
  '<main id="experiment"><button onclick="this.textContent=\'Changed\'">Interact</button>' +
  (declared ? '<script type="application/json" data-maic-observation>{}</script>' : '') +
  '</main>';
function hostBundle(declared: boolean) {
  return buildSync({
    absWorkingDir: process.cwd(),
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React, {useLayoutEffect,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createObservationSession} from './lib/interactive/observation-bridge';
import {createInteractiveMediaSession,mediaDocumentId,MEDIA_CONTROL} from './lib/interactive/media-bridge';
import {patchHtmlForIframe} from './lib/utils/iframe';
import {supportsInteractiveObservation, OBSERVATION_SCOPE_ID} from './lib/interactive/observation';
import {sampleInteractiveState} from './lib/interactive/chat-observation';
const useI18n=()=>({t:k=>k});
const widget={documentTokenByScene:{},sendMessageByScene:{},registerObservation(){},
 registerIframe(sceneId,send,token){widget.documentTokenByScene[sceneId]=token;widget.sendMessageByScene[sceneId]=send;},
 markIframeReady(){},getSendMessage(){return undefined}};
const useWidgetIframeStore=Object.assign(selector=>selector(widget),{getState:()=>widget});
const useCanvasStore={use:{pickTarget:()=>null}};
const useElementRefsStore={use:{refs:()=>[]}};
const runtimeErrorState={errors:{},clearScene(){}};
const useSceneRuntimeErrors=Object.assign((selector)=>selector(runtimeErrorState),{getState:()=>runtimeErrorState});
const InteractiveRuntimeErrorBanner=()=>null;
const InteractiveMoreBelowCue=()=>null;
const resolveInteractivePickerMode=()=>null;
import { GENUI_LOGICAL_WIDTH, GENUI_LOGICAL_HEIGHT } from './lib/interactive/logical-viewport';
import { GENUI_FIT_REPORT_REQUEST, GENUI_FIT_SCROLL_REQUEST, useGenUiFit } from './lib/interactive/use-genui-fit';
import { intersectClientBoxes } from './lib/edit/visible-client-rect';
${component}
window.sample=()=>sampleInteractiveState(
 {currentSceneId:'s',scenes:[{id:'s',content:{html:${JSON.stringify(activityHtml(declared))}}}]},new AbortController().signal);
// Mirrors the pool: identity is minted with the document, and only where the
// browser supports it — crypto.randomUUID does not exist in insecure contexts.
const IDENTITY=supportsInteractiveObservation()?{sceneId:'s',scopeId:'experiment',documentId:crypto.randomUUID()}:undefined;
createRoot(document.getElementById('app')).render(<PooledIframe sceneId="s" entry={{srcDoc:patchHtmlForIframe(${JSON.stringify(activityHtml(declared))},IDENTITY),observationIdentity:IDENTITY,rect:{left:0,top:0,width:1000,height:700},clip:null,owner:'o'}} visible={true} playbackArmed={false}/>);
`,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    // Next inlines NEXT_PUBLIC_* at build time, so the real bundle never reads
    // `process` at runtime. Mirror that here instead of leaving it undefined.
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_COURSEWARE_REFERENCE_ENABLED': '"true"',
    },
  }).outputFiles[0].text;
}

test.describe('Observation host origins', () => {
  for (const origin of ['http://openmaic-http.test/', 'http://localhost/']) {
    test(`renders declared and legacy activities and keeps sampling optional on ${origin}`, async ({
      page,
    }) => {
      for (const declared of [false, true]) {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route(origin, (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><body><div id="app"></div></body></html>',
          }),
        );
        await page.goto(origin);
        await page.addScriptTag({ content: hostBundle(declared) });
        const button = page.frameLocator('iframe').getByRole('button', { name: 'Interact' });
        await expect(button).toBeVisible();
        await button.click();
        await expect(page.frameLocator('iframe').getByRole('button')).toHaveText('Changed');
        const secure = await page.evaluate(() => isSecureContext);
        expect(secure).toBe(origin === 'http://localhost/');
        const packet = await page.evaluate(() =>
          (window as unknown as { sample(): Promise<unknown> }).sample(),
        );
        if (!secure) {
          // An insecure context cannot hash or mint an identity, so nothing is
          // sampled at all and a static reference travels untouched.
          expect(packet).toBeUndefined();
        } else {
          // Courseware without the interface is no longer pre-screened by a
          // substring match on the source: the reader answers for itself, and the
          // Host is what keeps a legacy unreferenced send unchanged (pinned by
          // `element-reference-route-l2`). Here no reader is registered, so both
          // shapes report `document-changed`.
          expect(packet).toMatchObject({
            snapshot: { status: 'unavailable', reason: 'document-changed' },
          });
          expect((packet as { sourceHtmlHash: string }).sourceHtmlHash).toMatch(/^[a-f0-9]{64}$/);
        }
        expect(errors).toEqual([]);
      }
    });
  }
});
