/** Keep the gateway shell separate from course HTML: no response rewriting or app instrumentation. */
export function installPreviewActivity(frame, activityKey) {
  'use strict';
  // Capture these before untrusted same-origin app code can replace its parent's
  // fetch/listener methods. Keep the capability in a private Request, not DOM,
  // storage, globals, or a callback registered through an app-owned method.
  const send = fetch.bind(globalThis),
    NativeRequest = Request;
  const listen = Function.prototype.call.bind(EventTarget.prototype.addEventListener);
  const status = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(Response.prototype, 'status').get,
  );
  const visibility = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get,
  );
  const create = Object.create,
    timeout = AbortSignal.timeout.bind(AbortSignal);
  const now = Date.now,
    wait = setTimeout,
    cancel = clearTimeout,
    watch = setInterval;
  const request = new NativeRequest(new URL('/__openmaic_activity', location.href), {
    method: 'POST',
    headers: { 'x-openmaic-preview-activity': activityKey },
  });
  let changed = false;
  let pending = false;
  let next = 0;
  let timer;
  const flush = async () => {
    cancel(timer);
    if (!changed || pending || visibility(document) !== 'visible') return;
    if (now() < next) {
      timer = wait(flush, next - now());
      return;
    }
    changed = false;
    pending = true;
    next = now() + 30_000;
    try {
      // No iterable headers or inherited RequestInit properties are exposed to app hooks.
      const init = create(null);
      init.signal = timeout(10_000);
      const response = await send(new NativeRequest(request, init));
      const code = status(response);
      if ((code < 200 || code >= 300) && code !== 403) changed = true;
    } catch {
      changed = true;
    } finally {
      pending = false;
      if (changed) void flush();
    }
  };
  const input = (event) => {
    if (!event.isTrusted || visibility(document) !== 'visible') return;
    changed = true;
    void flush();
  };
  const tracked = new WeakSet();
  const trackDocument = () => {
    // The protected app and this shell share only the isolated preview origin.
    // Cross-origin navigation is not an activity signal.
    try {
      const app = frame.contentDocument;
      if (!app || tracked.has(app)) return;
      tracked.add(app);
      for (const name of ['pointerdown', 'keydown', 'wheel'])
        listen(app, name, input, { capture: true, passive: true });
    } catch {}
  };
  // A usable document can precede iframe load by minutes (e.g. a pending image).
  // Also observe document replacement on navigation; observing is never activity.
  trackDocument();
  watch(trackDocument, 100);
  listen(frame, 'load', trackDocument);
  listen(document, 'visibilitychange', () => {
    if (visibility(document) === 'visible') void flush();
    else cancel(timer);
  });
}

export function previewShell(nonce) {
  return `<!doctype html><title>Application preview</title>
<style nonce="${nonce}">html,body{margin:0;width:100%;height:100%}iframe{width:100%;height:100%;border:0}#status{padding:1rem;font:14px sans-serif}</style>
<p id="status">Opening preview…</p><script nonce="${nonce}">
(()=>{'use strict';
let ticket=location.hash.slice(1);history.replaceState(null,'','/__openmaic_preview');
fetch('/__openmaic_authorize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})})
.then(async r=>{ticket='';if(!r.ok)throw Error();if(window.top===window){location.replace('/');return;}const {activityKey}=await r.json();if(typeof activityKey!=='string')throw Error();const frame=document.createElement('iframe');frame.title='Application';
(${installPreviewActivity.toString()})(frame,activityKey);frame.src='/';document.getElementById('status').remove();document.body.append(frame);})
.catch(()=>{document.getElementById('status').textContent='Access expired. Reopen from OpenMAIC.'});})();</script>`;
}
