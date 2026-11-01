import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import ts from 'typescript';

// Exercise the real iframe component and playback callbacks, isolating unrelated
// classroom UI, persistence and providers (as in interactive-observation-http).
function sourceFunction(path: string, name: string): string {
  const file = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let result = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(file);
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    )
      result = node.initializer.arguments[0].getText(file);
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(file) === name &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    )
      result = node.initializer.expression.getText(file);
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === name)
      result = node.initializer.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!result) throw new Error(`Missing production function: ${name}`);
  return result;
}

function wav(): string {
  const bytes = Buffer.alloc(44 + 8000 * 20);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(8000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 44; i < bytes.length; i++)
    bytes[i] = 128 + Math.round(32 * Math.sin(((i - 44) * 2 * Math.PI * 440) / 8000));
  return `data:audio/wav;base64,${bytes.toString('base64')}`;
}
const audio = wav();
const activity = `<button id="audio" onclick="document.querySelector('audio').play()">Audio</button><audio src="${audio}" loop></audio>
<button id="video" onclick="document.querySelector('video').play()">Video</button><video src="${audio}" loop></video>`;
const playbackPath = 'components/edit/PlaybackChromeRoot.tsx';
const hostPath = 'components/scene-renderers/InteractiveIframeHost.tsx';
function bundle(surface: 'app' | 'standalone'): string {
  return buildSync({
    absWorkingDir: process.cwd(),
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React,{useCallback,useLayoutEffect,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createInteractiveMediaSession,mediaDocumentId,MEDIA_CONTROL} from './lib/interactive/media-bridge';
import {patchHtmlForIframe} from './lib/utils/iframe';
const NativeAudio=window.Audio;window.audios=[];window.Audio=function(...args){const a=new NativeAudio(...args);window.audios.push(a);return a;};
const html=patchHtmlForIframe(${JSON.stringify(activity)}, undefined, {mediaId:'current'});
${
  surface === 'standalone'
    ? `
import {usePlayback} from './lib/standalone-player/playback/use-playback';
import {InteractiveScene} from './lib/standalone-player/scenes/InteractiveScene';
const speech=[{id:'first',type:'speech',text:'First narration',audioRef:'narration'},{id:'second',type:'speech',text:'Second narration',audioRef:'narration'}];
const scenes=[{type:'interactive',order:0,actions:speech,content:{type:'interactive'}},{type:'interactive',order:1,actions:speech,content:{type:'interactive'}}];
function App(){const [index,setIndex]=useState(0);const p=usePlayback(scenes,index,setIndex);window.navigateScene=()=>setIndex(index?0:1);window.mode=()=>p.state.mode;window.caption=()=>p.state.view.caption;return <><button onClick={p.play}>Narrate</button><button onClick={p.pause}>Pause</button><button onClick={p.toggle}>Toggle</button><button onClick={()=>setIndex(index?0:1)}>Navigate scene</button>{index===0&&<InteractiveScene html={html} strings={{}} title="test" widgets={p.widgets}/>}</>}
`
    : `
import {PlaybackEngine} from './lib/playback/engine';
import {AudioPlayer} from './lib/utils/audio-player';
import {useWidgetIframeStore} from './lib/store/widget-iframe';
import {GENUI_LOGICAL_WIDTH,GENUI_LOGICAL_HEIGHT,fitGenUiViewport} from './lib/interactive/logical-viewport';
import {intersectClientBoxes} from './lib/edit/visible-client-rect';
const useI18n=()=>({t:k=>k});const useCanvasStore={use:{pickTarget:()=>null}};const useElementRefsStore={use:{refs:()=>[]}};
const runtime={errors:{},clearScene(){}};const useSceneRuntimeErrors=Object.assign(s=>s(runtime),{getState:()=>runtime});
const InteractiveRuntimeErrorBanner=()=>null;const resolveInteractivePickerMode=()=>null;const createObservationSession=()=>null;
${sourceFunction(hostPath, 'PooledIframe')}
const lectureSessionIdRef={current:'lecture'};const chatAreaRef={current:{pauseBuffer(){window.bufferPauses=(window.bufferPauses||0)+1}}};
const pauseInteractiveMedia=${sourceFunction(playbackPath, 'pauseInteractiveMedia')};
const scene={id:'s',actions:[{id:'first',type:'speech',text:'First narration',audioId:'first'},{id:'second',type:'speech',text:'Second narration',audioId:'second'}]};
const activeSceneIdRef={current:'s'};
const engine=new PlaybackEngine([scene],{clearEffects(){},execute(){}},new AudioPlayer(),{beforeSpeech:pauseInteractiveMedia,onSpeechStart:text=>window.speech=text});const engineRef={current:engine};
const onMediaPlay=${sourceFunction(playbackPath, 'pauseForInteractiveMedia')};window.mode=()=>engine.getMode();window.caption=()=>window.speech;
function App(){const [visible,setVisible]=useState(true);return <><button onClick={()=>engine.getMode()==='idle'?engine.start():engine.resume()}>Narrate</button><button onClick={()=>engine.pause()}>Pause</button><button onClick={()=>{engine.stop();setVisible(!visible)}}>Navigate scene</button><PooledIframe onMediaPlay={onMediaPlay} sceneId="s" entry={{srcDoc:html,rect:{left:0,top:100,width:1280,height:720},clip:{left:0,top:100,width:1280,height:720},owner:'o'}} visible={visible} playbackArmed={false}/></>}
`
}
window.narrating=()=>window.audios.some(a=>a.duration>10&&!a.paused&&a.currentTime>0);
createRoot(document.getElementById('app')).render(<App/>);
`,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    alias:
      surface === 'app'
        ? {
            '@/lib/store/canvas': './e2e/fixtures/media-stubs.ts',
            '@/lib/store/settings': './e2e/fixtures/media-stubs.ts',
            '@/lib/audio/tts-selection': './e2e/fixtures/media-stubs.ts',
            '@/lib/media/resolve-audio-bytes': './e2e/fixtures/media-stubs.ts',
          }
        : {},
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.LOG_LEVEL': 'undefined',
      'process.env.LOG_FORMAT': 'undefined',
    },
  }).outputFiles[0].text;
}
async function narrate(page: Page) {
  await page.getByRole('button', { name: 'Narrate', exact: true }).click();
  await expect.poll(() => page.evaluate('narrating()')).toBe(true);
}

for (const surface of ['app', 'standalone'] as const) {
  test.describe(surface, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.route('http://localhost/narration.wav', (route) =>
        route.fulfill({
          contentType: 'audio/wav',
          body: Buffer.from(audio.split(',')[1], 'base64'),
        }),
      );
      await page.route('http://localhost/media-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><style>.relative{position:relative;width:1280px;height:720px}.absolute{position:absolute}.inset-0{inset:100px 0 0}</style></head><body><script id="openmaic-media" type="application/json">${JSON.stringify({ narration: { src: audio } })}</script><div id="app"></div></body></html>`,
        }),
      );
      await page.goto('http://localhost/media-test');
      await page.addScriptTag({ content: bundle(surface) });
      await expect(page.frameLocator('iframe').locator('#audio')).toBeVisible();
    });

    for (const kind of ['audio', 'video'] as const) {
      test(`${kind}: narration start/resume pauses media; media play pauses narration`, async ({
        page,
      }) => {
        const frame = page.frames()[1];
        await page
          .frameLocator('iframe')
          .locator('#' + kind)
          .click();
        await expect
          .poll(() =>
            frame.evaluate(
              (tag) => !(document.querySelector(tag) as HTMLMediaElement).paused,
              kind,
            ),
          )
          .toBe(true);
        await narrate(page);
        await expect
          .poll(() =>
            frame.evaluate((tag) => (document.querySelector(tag) as HTMLMediaElement).paused, kind),
          )
          .toBe(true);
        await page
          .frameLocator('iframe')
          .locator('#' + kind)
          .click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await expect.poll(() => page.evaluate('narrating()')).toBe(false);
        await narrate(page);
        await expect
          .poll(() =>
            frame.evaluate((tag) => (document.querySelector(tag) as HTMLMediaElement).paused, kind),
          )
          .toBe(true);
      });
    }

    test('retains the opaque sandbox and rejects a play signal from the parent window', async ({
      page,
    }) => {
      await narrate(page);
      const frame = page.frames()[1];
      expect(
        await frame.evaluate(() => {
          try {
            void parent.document;
            return false;
          } catch (error) {
            return error instanceof DOMException && error.name === 'SecurityError';
          }
        }),
      ).toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const received = (event: MessageEvent) => {
              if (event.source === window && event.data?.type === 'maic:media:play:v1') {
                window.removeEventListener('message', received);
                resolve();
              }
            };
            window.addEventListener('message', received);
            window.postMessage({ type: 'maic:media:play:v1', documentId: 'current' }, '*');
          }),
      );
      expect(await page.evaluate('mode()')).toBe('playing');
      expect(await page.evaluate('narrating()')).toBe(true);
    });
  });
}
