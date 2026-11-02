/** Cooperative signals are not a security boundary; keep the opaque sandbox. */
export const MEDIA_CONTROL = 'maic:media:control:v1';
const MEDIA_PLAY = 'maic:media:play:v1';

/** Install before authored scripts; keep the prelude independent of bundler helpers. */
const MEDIA_BRIDGE = String.raw`(function (documentId) {
  document.addEventListener('play', function (event) {
    if (event.target instanceof HTMLMediaElement) {
      window.parent.postMessage({ type: 'maic:media:play:v1', documentId: documentId }, '*');
    }
  }, true);
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'maic:media:control:v1' || data.documentId !== documentId || data.action !== 'pause') return;
    document.querySelectorAll('audio, video').forEach(function (element) { element.pause(); });
  });
})(__DOCUMENT_ID__);`;

export function mediaBridgeScript(documentId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(documentId)) throw new Error('Invalid media document id');
  return `<script data-maic-media-document="${documentId}">${MEDIA_BRIDGE.replace('__DOCUMENT_ID__', JSON.stringify(documentId))}</script>`;
}

export function mediaDocumentId(html: string | undefined): string | undefined {
  return html?.match(/<script data-maic-media-document="([a-zA-Z0-9_-]+)">/)?.[1];
}

export function createInteractiveMediaSession(
  frame: HTMLIFrameElement,
  documentId: string,
  onPlay: () => void,
) {
  const onMessage = (event: MessageEvent) => {
    const data = event.data;
    if (
      event.source !== frame.contentWindow ||
      !data ||
      data.type !== MEDIA_PLAY ||
      data.documentId !== documentId
    )
      return;
    onPlay();
  };
  window.addEventListener('message', onMessage);
  return {
    pause() {
      frame.contentWindow?.postMessage({ type: MEDIA_CONTROL, documentId, action: 'pause' }, '*');
    },
    dispose() {
      window.removeEventListener('message', onMessage);
    },
  };
}
