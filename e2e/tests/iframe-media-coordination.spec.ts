import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import ts from 'typescript';
import { patchHtmlForIframe } from '../../lib/utils/iframe';

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
// Model a temporarily unresponsive frame before its bridge receives commands.
const dropControls = `<script>const add=window.addEventListener;window.addEventListener=function(type,listener,options){if(type==='message'){add.call(this,type,function(event){if(window.blockMediaControls&&event.data?.type==='maic:media:control:v1'){if(window.playOnBlockedPause&&event.data.action==='pause')document.querySelector('audio').play();return}listener.call(this,event)},options);window.addEventListener=add}else add.call(this,type,listener,options)};</script>`;
const activity = `<button id="audio" onclick="document.querySelector('audio').play()">Frame audio</button><audio id="a" src="${audio}" loop></audio>
<button id="video" onclick="document.querySelector('video').play()">Frame video</button><video id="v" src="${audio}" loop></video>
<button id="detached" onclick="detached.play()">Detached audio</button>
<button id="context" onclick="if(!window.ctx){ctx=new AudioContext();let o=ctx.createOscillator();o.connect(ctx.destination);o.start()}ctx.resume()">WebAudio</button>
<button id="reuse-context" onclick="if(!window.ctx){ctx=new AudioContext();let o=ctx.createOscillator();o.connect(ctx.destination);o.start();ctx.resume()}">Reuse WebAudio</button>
<form action="http://localhost/without-media-bridge"><button id="self-navigate">Navigate frame</button></form>
<script>window.detached=new Audio(${JSON.stringify(audio)});detached.loop=true;</script>`;
const hostPath = 'components/scene-renderers/InteractiveIframeHost.tsx';
const playbackPath = 'components/edit/PlaybackChromeRoot.tsx';

function bundle(surface: 'app' | 'standalone', restart = false): string {
  return buildSync({
    absWorkingDir: process.cwd(),
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React,{useCallback,useLayoutEffect,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {patchHtmlForIframe} from './lib/utils/iframe';
import {createInteractiveMediaSession,mediaDocumentId,MEDIA_CONTROL} from './lib/interactive/media-bridge';
const NativeAudio=window.Audio;window.audios=[];window.Audio=function(...args){const a=new NativeAudio(...args);window.audios.push(a);return a;};
const html=${JSON.stringify(patchHtmlForIframe(activity, undefined, 'current').replace('<script data-maic-media-document', dropControls + '<script data-maic-media-document'))};
${
  surface === 'standalone'
    ? `
import {usePlayback} from './lib/standalone-player/playback/use-playback';
import {InteractiveScene} from './lib/standalone-player/scenes/InteractiveScene';
const speech=[{id:'speech',type:'speech',text:'Narration',audioRef:'narration'},{id:'second',type:'speech',text:'Second narration',audioRef:'narration'}];
const scenes=[{type:'interactive',order:0,actions:speech,content:{type:'interactive'}},{type:'interactive',order:1,actions:${restart ? 'speech' : '[]'},content:{type:'interactive'}}];
function App(){const [index,setIndex]=useState(${restart ? 1 : 0});const p=usePlayback(scenes,index,setIndex);window.mode=()=>p.state.mode;window.caption=()=>p.state.view.caption;window.sceneIndex=()=>index;
return <><button onClick={p.play}>Narrate</button><button onClick={p.pause}>Pause</button><button onClick={()=>setIndex(index?0:1)}>Navigate</button>{index===${restart ? 1 : 0}&&<InteractiveScene html={html} strings={{}} title="test" widgets={p.widgets}/>}</>}
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
const currentScene={id:'s',type:'interactive',actions:[{id:'speech',type:'speech',text:'Narration',audioId:'narration'},{id:'second',type:'speech',text:'Second narration',audioId:'narration'}],content:{type:'interactive'}};
const setEngineMode=()=>{};const lectureSessionIdRef={current:null};const chatAreaRef={current:null};const discussionTTS={pause(){}};const setIsDiscussionPaused=()=>{};
window.proactive=null;
const engineRef={current:new PlaybackEngine([currentScene],{clearEffects(){},execute(){}},new AudioPlayer(),{beforeSpeech:async()=> (await useWidgetIframeStore.getState().sendMessageByScene.s?.(MEDIA_CONTROL,{}))!==false,onModeChange:${sourceFunction(playbackPath, 'onModeChange')},onProactiveShow:trigger=>{window.proactive=trigger.id}})};
const onMediaPlay=${sourceFunction(playbackPath, 'pauseForInteractiveMedia')};window.mode=()=>engineRef.current.getMode();
window.cursor=()=>engineRef.current.getSnapshot().actionIndex;
window.prepareDiscussion=()=>currentScene.actions.unshift({id:'delayed',type:'discussion',topic:'Question',prompt:'Discuss'});
window.skipDiscussion=()=>engineRef.current.skipDiscussion();
function App(){const [visible,setVisible]=useState(true);return <><button onClick={()=>engineRef.current.getMode()==='idle'?engineRef.current.start():engineRef.current.resume()}>Narrate</button><button onClick={()=>engineRef.current.pause()}>Pause</button><button onClick={()=>{engineRef.current.stop();setVisible(!visible)}}>Navigate</button><PooledIframe onMediaPlay={onMediaPlay} sceneId="s" entry={{srcDoc:html,rect:{left:0,top:100,width:1280,height:720},clip:{left:0,top:100,width:1280,height:720},owner:'o'}} visible={visible} playbackArmed={false}/></>}
`
}
window.narrationPaused=()=>window.audios[0]?.paused??true;
createRoot(document.getElementById('app')).render(<App/>);
`,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    // Isolate only the engine's unrelated presentation/settings dependencies.
    alias:
      surface === 'app'
        ? {
            '@/lib/store/canvas': './e2e/fixtures/media-stubs.ts',
            '@/lib/store/settings': './e2e/fixtures/media-stubs.ts',
            '@/lib/audio/tts-selection': './e2e/fixtures/media-stubs.ts',
            '@/lib/media/resolve-audio-bytes': './e2e/fixtures/media-stubs.ts',
          }
        : {},
    define: { 'process.env.NODE_ENV': '"production"' },
  }).outputFiles[0].text;
}

async function finishFrameLoad(page: Page) {
  const child = page.frames()[1];
  // A late load must not reset the deliberately unresponsive frame's playing report.
  await child.evaluate(() => {
    document.querySelectorAll<HTMLMediaElement>('audio,video').forEach((media) => {
      media.preload = 'none';
      media.removeAttribute('src');
      media.load();
    });
    const detached = (window as unknown as { detached: HTMLAudioElement }).detached;
    detached.removeAttribute('src');
    detached.load();
  });
  await expect.poll(() => child.evaluate('document.readyState')).toBe('complete');
  await child.evaluate((src) => {
    document.querySelector('audio')!.src = src;
  }, audio);
}

async function startUnresponsiveFrame(page: Page) {
  const playing = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const listener = (event: MessageEvent) => {
          if (
            event.source === document.querySelector('iframe')?.contentWindow &&
            event.data?.type === 'maic:media:state:v1' &&
            event.data.generation > 0 &&
            event.data.playing
          ) {
            window.removeEventListener('message', listener);
            resolve();
          }
        };
        window.addEventListener('message', listener);
      }),
  );
  await page.frameLocator('iframe').locator('#audio').click();
  await playing;
  await page.frames()[1].evaluate(() => {
    (window as unknown as { blockMediaControls: boolean }).blockMediaControls = true;
  });
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
      await page.route(/^http:\/\/localhost\/without-media-bridge(?:\?.*)?$/, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<p id="no-bridge">Navigated document</p>',
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

    test('continues both narration lines after a form navigates to an uninstrumented document', async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
      await page.frameLocator('iframe').locator('#audio').click();
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await page.frameLocator('iframe').locator('#self-navigate').click();
      await expect(page.frameLocator('iframe').locator('#no-bridge')).toBeVisible();
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
      await page.evaluate('audios[0].pause(); audios[0].dispatchEvent(new Event("ended"))');
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
      expect(await page.evaluate('mode()')).toBe('playing');
      expect(await page.locator('iframe').getAttribute('sandbox')).not.toContain(
        'allow-same-origin',
      );
      if (surface === 'app') expect(await page.evaluate('cursor()')).toBe(2);
      else expect(await page.evaluate('caption()')).toBe('Second narration');
    });

    test('restores bridge-suspended WebAudio on a later user gesture without authored resume', async ({
      page,
    }) => {
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await page.frameLocator('iframe').locator('#reuse-context').click();
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      const child = page.frames()[1];
      const state = () =>
        child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state);
      await expect.poll(state).toBe('suspended');
      await page.frameLocator('iframe').locator('#reuse-context').click();
      await expect.poll(state).toBe('running');
      await expect.poll(() => page.evaluate('mode()')).toBe('paused');
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect.poll(state).toBe('suspended');
      await child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.suspend());
      await page.frameLocator('iframe').locator('#reuse-context').click();
      await expect.poll(state).toBe('suspended');
      expect(await page.evaluate('mode()')).toBe('playing');
    });

    if (surface === 'app') {
      test('retains a delayed discussion when frame media pauses the engine', async ({ page }) => {
        await page.evaluate('prepareDiscussion()');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await page.frameLocator('iframe').locator('#audio').click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('proactive')).toBe('delayed');
        expect(await page.evaluate('narrationPaused()')).toBe(true);
        await page.evaluate('skipDiscussion()');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
      });

      test('parks real AudioPlayer byte loading when frame media starts and retries the same line', async ({
        page,
      }) => {
        let release!: () => void;
        let requests = 0;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route('http://localhost/narration.wav', async (route) => {
          if (++requests === 1) await blocked;
          await route.fulfill({
            contentType: 'audio/wav',
            body: Buffer.from(audio.split(',')[1], 'base64'),
          });
        });
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => requests).toBe(1);
        await page.frameLocator('iframe').locator('#audio').click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        expect(await page.evaluate('cursor()')).toBe(0);
        release();
        expect(await page.evaluate('narrationPaused()')).toBe(true);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => requests).toBe(2);
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        expect(await page.evaluate('cursor()')).toBe(1);
      });
    }

    if (surface === 'standalone') {
      test('restarts from the final iframe while it ignores silence controls', async ({ page }) => {
        await page.goto('http://localhost/media-test');
        await page.addScriptTag({ content: bundle(surface, true) });
        await expect(page.frameLocator('iframe').locator('#audio')).toBeVisible();
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await page.evaluate('audios[0].pause(); audios[0].dispatchEvent(new Event("ended"))');
        await expect.poll(() => page.evaluate('caption()')).toBe('Second narration');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await page.evaluate('audios[0].pause(); audios[0].dispatchEvent(new Event("ended"))');
        await expect.poll(() => page.evaluate('mode()')).toBe('idle');
        await startUnresponsiveFrame(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('sceneIndex()')).toBe(0);
        await expect(page.locator('iframe')).toHaveCount(0);
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        expect(await page.evaluate('caption()')).toBe('Narration');
      });

      test('continues from holding while the departing frame ignores silence controls', async ({
        page,
      }) => {
        await finishFrameLoad(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await page.evaluate('audios[0].pause(); audios[0].dispatchEvent(new Event("ended"))');
        await expect.poll(() => page.evaluate('caption()')).toBe('Second narration');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await page.evaluate('audios[0].pause(); audios[0].dispatchEvent(new Event("ended"))');
        await expect.poll(() => page.evaluate('mode()')).toBe('holding');
        await startUnresponsiveFrame(page);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect(page.locator('iframe')).toHaveCount(0);
        await expect.poll(() => page.evaluate('mode()')).toBe('idle');
      });

      test('retains a second narration after a silence timeout and retries it on Play', async ({
        page,
      }) => {
        await page.frameLocator('iframe').locator('#audio').click();
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect
          .poll(() =>
            page.evaluate(
              'Number.isFinite(audios[0].duration) && audios[0].duration > 1 && !audios[0].paused',
            ),
          )
          .toBe(true);
        const child = page.frames()[1];
        await child.evaluate(() => {
          (window as unknown as { blockMediaControls: boolean }).blockMediaControls = true;
          (window as unknown as { playOnBlockedPause: boolean }).playOnBlockedPause = true;
        });
        // Seed clip completion: the local headless Firefox backend does not emit ended reliably.
        await page.evaluate('audios[0].pause(); audios[0].dispatchEvent(new Event("ended"))');
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        expect(await page.evaluate('caption()')).toBe('Second narration');
        expect(await page.evaluate('narrationPaused()')).toBe(true);
        await child.evaluate(() => {
          (window as unknown as { blockMediaControls: boolean }).blockMediaControls = false;
        });
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        expect(await page.evaluate('caption()')).toBe('Second narration');
        expect(await page.evaluate('mode()')).toBe('playing');
      });
    }

    for (const media of ['audio', 'video', 'detached', 'context']) {
      test(`${media} pauses narration; resuming narration pauses frame media`, async ({ page }) => {
        const frame = page.frameLocator('iframe');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await frame.locator(`#${media}`).click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
        const state = () =>
          page
            .frames()[1]
            .evaluate(
              (media) =>
                media === 'context'
                  ? (window as unknown as { ctx: AudioContext }).ctx.state
                  : media === 'detached'
                    ? (window as unknown as { detached: HTMLAudioElement }).detached.paused
                    : (document.querySelector(media) as HTMLMediaElement).paused,
              media,
            );
        await expect.poll(state).toBe(media === 'context' ? 'running' : false);
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(state).toBe(media === 'context' ? 'suspended' : true);
        await expect.poll(() => page.evaluate('mode()')).toBe('playing');
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await page.getByRole('button', { name: 'Pause', exact: true }).click();
        await expect.poll(() => page.evaluate('mode()')).toBe('paused');
        await page.getByRole('button', { name: 'Narrate', exact: true }).click();
        await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
        await expect.poll(state).toBe(media === 'context' ? 'suspended' : true);
      });
    }

    test('waits for asynchronous WebAudio silence before resuming narration', async ({ page }) => {
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      const child = page.frames()[1];
      await child.evaluate(() => {
        const w = window as unknown as { releaseSuspension: () => void };
        const suspend = AudioContext.prototype.suspend;
        AudioContext.prototype.suspend = function () {
          const context = this;
          return new Promise<void>((resolve) => {
            w.releaseSuspension = () => {
              void suspend.call(context).then(resolve);
            };
          });
        };
      });
      await page.frameLocator('iframe').locator('#context').click();
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(true);
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await expect
        .poll(() =>
          child.evaluate(
            () => typeof (window as unknown as { releaseSuspension?: unknown }).releaseSuspension,
          ),
        )
        .toBe('function');
      expect(await page.evaluate('narrationPaused()')).toBe(true);
      expect(
        await child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state),
      ).toBe('running');
      await child.evaluate(() =>
        (window as unknown as { releaseSuspension: () => void }).releaseSuspension(),
      );
      await expect
        .poll(() => child.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.state))
        .toBe('suspended');
      await expect.poll(() => page.evaluate('narrationPaused()')).toBe(false);
    });

    test('navigation silences the old frame and leaves it paused on return', async ({ page }) => {
      await page.frameLocator('iframe').locator('#audio').click();
      const old = page.frames()[1];
      await page.getByRole('button', { name: 'Navigate', exact: true }).click();
      if (surface === 'app') {
        await expect
          .poll(() => old.locator('audio').evaluate((x: HTMLAudioElement) => x.paused))
          .toBe(true);
        // A hidden keep-alive page trying to restart itself must stay silent.
        await old.locator('audio').evaluate((x: HTMLAudioElement) => x.play().catch(() => {}));
        await expect
          .poll(() => old.locator('audio').evaluate((x: HTMLAudioElement) => x.paused))
          .toBe(true);
      } else await expect.poll(() => old.isDetached()).toBe(true);
      await page.getByRole('button', { name: 'Navigate', exact: true }).click();
      await expect
        .poll(() =>
          page
            .frames()[1]
            .locator('audio')
            .evaluate((x: HTMLAudioElement) => x.paused),
        )
        .toBe(true);
    });

    test('ignores spoofed/stale messages and keeps an opaque origin', async ({ page }) => {
      await page.getByRole('button', { name: 'Narrate', exact: true }).click();
      await page.evaluate(() =>
        window.postMessage(
          { type: 'maic:media:state:v1', documentId: 'current', playing: true },
          '*',
        ),
      );
      await page.frames()[1].evaluate(() => {
        parent.postMessage({ type: 'maic:media:state:v1', documentId: 'old', playing: true }, '*');
        parent.postMessage(
          { type: 'maic:media:state:v1', documentId: 'current', playing: 'true' },
          '*',
        );
      });
      await expect.poll(() => page.evaluate('mode()')).toBe('playing');
      expect(await page.locator('iframe').getAttribute('sandbox')).not.toContain(
        'allow-same-origin',
      );
      expect(
        await page.frames()[1].evaluate(() => {
          try {
            void parent.document.body;
            return false;
          } catch {
            return true;
          }
        }),
      ).toBe(true);
    });
  });
}
