import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(process.cwd() + '/package.json');
const { buildSync } = require(
  createRequire(require.resolve('tsx/package.json')).resolve('esbuild'),
);
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
const html = (declared: boolean) =>
  '<main id="experiment"><button onclick="this.textContent=\'Changed\'">Interact</button>' +
  (declared ? '<script type="application/json" data-maic-observation>{}</script>' : '') +
  '</main>';
function bundle(declared: boolean) {
  return buildSync({
    absWorkingDir: process.cwd(),
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React, {useLayoutEffect,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createObservationSession} from './lib/interactive/observation-bridge';
import {patchHtmlForIframe} from './lib/utils/iframe';
import {supportsInteractiveObservation, OBSERVATION_SCOPE_ID} from './lib/interactive/observation';
import {sampleInteractiveState} from './lib/interactive/chat-observation';
const useI18n=()=>({t:k=>k});
const widget={registerObservation(){},registerIframe(){},markIframeReady(){},getSendMessage(){return undefined}};
const useWidgetIframeStore=selector=>selector(widget);
const useCanvasStore={use:{pickTarget:()=>null}};
const useElementRefsStore={use:{refs:()=>[]}};
const useSceneRuntimeErrors={getState:()=>({clearScene(){}})};
const resolveInteractivePickerMode=()=>null;
import { GENUI_LOGICAL_WIDTH, GENUI_LOGICAL_HEIGHT, fitGenUiViewport } from './lib/interactive/logical-viewport';
import { intersectClientBoxes } from './lib/edit/visible-client-rect';
${component}
window.sample=()=>sampleInteractiveState(
 {currentSceneId:'s',scenes:[{id:'s',content:{html:${JSON.stringify(html(declared))}}}]},new AbortController().signal);
// Mirrors the pool: identity is minted with the document, and only where the
// browser supports it — crypto.randomUUID does not exist in insecure contexts.
const IDENTITY=supportsInteractiveObservation()?{sceneId:'s',scopeId:'experiment',documentId:crypto.randomUUID()}:undefined;
createRoot(document.getElementById('app')).render(<PooledIframe sceneId="s" entry={{srcDoc:patchHtmlForIframe(${JSON.stringify(html(declared))},IDENTITY),observationIdentity:IDENTITY,rect:{left:0,top:0,width:1000,height:700},clip:null,owner:'o'}} visible={true} playbackArmed={false}/>);
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
for (const origin of ['http://openmaic-http.test/', 'http://localhost/']) {
  for (const declared of [false, true]) {
    test(`renders ${declared ? 'declared' : 'legacy'} activity and keeps sampling optional on ${origin}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route(origin, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><body><div id="app"></div></body></html>',
        }),
      );
      await page.goto(origin);
      await page.addScriptTag({ content: bundle(declared) });
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
    });
  }
}
