// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import {
  createInteractiveMediaSession,
  mediaBridgeScript,
  mediaDocumentId,
  MEDIA_CONTROL,
} from '@/lib/interactive/media-bridge';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});

function fixture() {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const onPlay = vi.fn();
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  const session = createInteractiveMediaSession(frame, 'current', onPlay);
  cleanups.push(session.dispose);
  const message = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
    window.dispatchEvent(new MessageEvent('message', { source, data }));
  return { frame, onPlay, post, session, message };
}

const playing = { type: 'maic:media:play:v1', documentId: 'current' };
describe('HTML media coordination', () => {
  it('accepts play only from the current frame and document, and removes its listener', () => {
    const { onPlay, session, message } = fixture();
    for (const data of [null, {}, { ...playing, type: 'other' }, { ...playing, documentId: 'old' }])
      message(data);
    message(playing, window);
    message(playing, null);
    expect(onPlay).not.toHaveBeenCalled();
    message(playing);
    expect(onPlay).toHaveBeenCalledOnce();
    session.dispose();
    message(playing);
    expect(onPlay).toHaveBeenCalledOnce();
  });

  it('posts each pause immediately without a reply, timer or Promise', () => {
    const { post, session } = fixture();
    expect(post).not.toHaveBeenCalled();
    const timer = vi.spyOn(window, 'setTimeout');
    expect(session.pause()).toBeUndefined();
    expect(session.pause()).toBeUndefined();
    expect(post.mock.calls).toEqual([
      [{ type: MEDIA_CONTROL, documentId: 'current', action: 'pause' }, '*'],
      [{ type: MEDIA_CONTROL, documentId: 'current', action: 'pause' }, '*'],
    ]);
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });

  it('reports audio/video play and pauses them only for validated parent commands', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument!;
    const view = frame.contentWindow as Window & typeof globalThis;
    doc.body.innerHTML = '<audio></audio><video></video><button>Button</button>';
    const media = Array.from(doc.querySelectorAll<HTMLMediaElement>('audio, video'));
    const pauses = media.map((element) => vi.spyOn(element, 'pause').mockImplementation(() => {}));
    const parent = { postMessage: vi.fn() };
    let receive!: (event: { source: unknown; data: unknown }) => void;
    const AudioContext = class {};
    const sourceStart = vi.fn();
    const source = { prototype: { start: sourceStart } };
    const child = {
      parent,
      AudioContext,
      AudioScheduledSourceNode: source,
      addEventListener: (_: string, listener: typeof receive) => {
        receive = listener;
      },
    };
    const script = mediaBridgeScript('current')
      .replace(/^<script[^>]*>/, '')
      .replace(/<\/script>$/, '');
    runInNewContext(script, {
      document: doc,
      window: child,
      HTMLMediaElement: view.HTMLMediaElement,
    });
    expect(child.AudioContext).toBe(AudioContext);
    expect(source.prototype.start).toBe(sourceStart);
    expect(parent.postMessage).not.toHaveBeenCalled();
    for (const element of media) element.dispatchEvent(new view.Event('play'));
    doc.querySelector('button')!.dispatchEvent(new view.Event('play'));
    expect(parent.postMessage.mock.calls).toEqual([
      [playing, '*'],
      [playing, '*'],
    ]);
    const pause = { type: MEDIA_CONTROL, documentId: 'current', action: 'pause' };
    receive({ source: {}, data: pause });
    for (const data of [null, {}, { ...pause, documentId: 'old' }, { ...pause, action: 'sync' }])
      receive({ source: parent, data });
    pauses.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    receive({ source: parent, data: pause });
    pauses.forEach((spy) => expect(spy).toHaveBeenCalledOnce());
    expect(parent.postMessage).toHaveBeenCalledTimes(2);
  });

  it('embeds a validated document identity', () => {
    expect(mediaDocumentId(mediaBridgeScript('current'))).toBe('current');
    expect(mediaDocumentId(undefined)).toBeUndefined();
    expect(() => mediaBridgeScript('x"><script>')).toThrow('Invalid media document id');
  });
});
