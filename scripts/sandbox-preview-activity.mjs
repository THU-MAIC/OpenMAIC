/** Keep the gateway shell separate from course HTML: no response rewriting or learner source edits. */
export function installPreviewActivity(frame, activityKey, appOrigin, controlled) {
  'use strict';
  // Capture these before untrusted same-origin app code can replace its parent's
  // fetch/listener methods. Keep the capability in a private Request, not DOM,
  // storage, globals, or a callback registered through an app-owned method.
  const send = fetch.bind(globalThis),
    NativeRequest = Request,
    NativePromise = Promise;
  const listen = Function.prototype.call.bind(EventTarget.prototype.addEventListener);
  const status = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(Response.prototype, 'status').get,
  );
  const responseHeaders = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(Response.prototype, 'headers').get,
  );
  const header = Function.prototype.call.bind(Headers.prototype.get);
  const owner = parent;
  const notify = typeof appOrigin === 'string' ? owner.postMessage.bind(owner) : null;
  const visibility = Function.prototype.call.bind(
    Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get,
  );
  const create = Object.create,
    define = Object.defineProperty,
    timeout = AbortSignal.timeout.bind(AbortSignal);
  const now = Date.now,
    wait = setTimeout,
    cancel = clearTimeout,
    watch = setInterval;
  const request = new NativeRequest(new URL('/__openmaic_activity', location.href), {
    method: 'POST',
    headers: { 'x-openmaic-preview-activity': activityKey },
  });
  let enabled = !controlled;
  const inertRoots = new WeakMap();
  const inertDescriptor = controlled
    ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert')
    : null;
  const getInert = inertDescriptor && Function.prototype.call.bind(inertDescriptor.get);
  const setInert = inertDescriptor && Function.prototype.call.bind(inertDescriptor.set);
  const nativeGet = (prototype, name) =>
    Function.prototype.call.bind(Object.getOwnPropertyDescriptor(prototype, name).get);
  const message = controlled
    ? {
        source: nativeGet(MessageEvent.prototype, 'source'),
        origin: nativeGet(MessageEvent.prototype, 'origin'),
        data: nativeGet(MessageEvent.prototype, 'data'),
        document: nativeGet(HTMLIFrameElement.prototype, 'contentDocument'),
        root: nativeGet(Document.prototype, 'documentElement'),
      }
    : null;
  const prevent = Function.prototype.call.bind(Event.prototype.preventDefault);
  const stop = Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
  let changed = false;
  let pending = false;
  let next = 0;
  let timer;
  const flush = async () => {
    cancel(timer);
    if (!enabled || !changed || pending || visibility(document) !== 'visible') return;
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
      const result = send(new NativeRequest(request, init));
      // Keep await on the native Promise path, bypassing app-controlled
      // prototype constructor/then hooks that could substitute a response.
      const descriptor = create(null);
      descriptor.value = NativePromise;
      define(result, 'constructor', descriptor);
      const response = await result;
      const code = status(response);
      if (code === 204 && notify) {
        const expiresAt = Number(
          header(responseHeaders(response), 'x-openmaic-preview-expires-at'),
        );
        if (Number.isFinite(expiresAt) && expiresAt > now() && expiresAt <= now() + 300_000)
          notify({ type: 'openmaic-preview-activity', expiresAt }, appOrigin);
      }
      if ((code < 200 || code >= 300) && code !== 403) changed = enabled;
    } catch {
      changed = enabled;
    } finally {
      pending = false;
      if (changed) void flush();
    }
  };
  const input = (event) => {
    if (!event.isTrusted || visibility(document) !== 'visible') return;
    if (!enabled) {
      prevent(event);
      stop(event);
      return;
    }
    changed = true;
    void flush();
  };
  const tracked = new WeakSet();
  const trackDocument = () => {
    // The protected app and this shell share only the isolated preview origin.
    // Cross-origin navigation is not an activity signal.
    try {
      const app = controlled ? message.document(frame) : frame.contentDocument;
      if (!app) return;
      const root = controlled ? message.root(app) : null;
      if (controlled && root) {
        if (!enabled) {
          if (!inertRoots.has(root)) inertRoots.set(root, getInert(root));
          setInert(root, true);
        } else if (inertRoots.has(root)) {
          setInert(root, inertRoots.get(root));
          inertRoots.delete(root);
        }
      }
      if (tracked.has(app)) return;
      tracked.add(app);
      for (const name of ['pointerdown', 'keydown', 'wheel'])
        listen(app, name, input, { capture: true, passive: !controlled });
    } catch {}
  };
  if (controlled && notify) {
    let refreshedRun;
    listen(globalThis, 'message', (event) => {
      if (
        !event.isTrusted ||
        message.source(event) !== owner ||
        message.origin(event) !== appOrigin
      )
        return;
      const data = message.data(event);
      if (data?.type === 'openmaic-preview-host-activity') {
        if (enabled && visibility(document) === 'visible') {
          changed = true;
          void flush();
        }
        return;
      }
      if (data?.type !== 'openmaic-preview-input' || typeof data.enabled !== 'boolean') return;
      enabled = data.enabled;
      if (!enabled) {
        changed = false;
        cancel(timer);
      }
      trackDocument();
      if (enabled && typeof data.runId === 'string' && data.runId !== refreshedRun) {
        refreshedRun = data.runId;
        frame.contentWindow?.postMessage({ type: 'openmaic-preview-refresh' }, location.origin);
      }
    });
    notify({ type: 'openmaic-preview-input-request' }, appOrigin);
  }
  // A usable document can precede iframe load by minutes (e.g. a pending image).
  // Also observe document replacement on navigation; observing is never activity.
  trackDocument();
  watch(trackDocument, 100);
  listen(frame, 'load', trackDocument);
  listen(document, 'visibilitychange', () => {
    if (visibility(document) === 'visible') void flush();
    else cancel(timer);
  });
  return trackDocument;
}

/** Only the owned shell reports the nested document's browser-observed readiness. */
export function installPreviewReadiness(frame, appOrigin, prepareDocument) {
  'use strict';
  if (typeof appOrigin !== 'string') return;
  const notify = parent.postMessage.bind(parent);
  const getter = (prototype, name) =>
    Function.prototype.call.bind(Object.getOwnPropertyDescriptor(prototype, name).get);
  const contentDocument = getter(HTMLIFrameElement.prototype, 'contentDocument');
  const readyState = getter(Document.prototype, 'readyState');
  const contentType = getter(Document.prototype, 'contentType');
  const documentURL = getter(Document.prototype, 'URL');
  const listen = Function.prototype.call.bind(EventTarget.prototype.addEventListener);
  const cancel = clearInterval;
  let done = false;
  let timer;
  const inspect = (loaded = false) => {
    if (done) return;
    try {
      const doc = contentDocument(frame);
      if (
        doc &&
        documentURL(doc) !== 'about:blank' &&
        ['interactive', 'complete'].includes(readyState(doc))
      ) {
        const html = ['text/html', 'application/xhtml+xml'].includes(contentType(doc));
        if (prepareDocument) prepareDocument();
        if (html) frame.style.visibility = '';
        done = true;
        cancel(timer);
        notify({ type: html ? 'openmaic-preview-ready' : 'openmaic-preview-error' }, appOrigin);
      } else if (loaded && !doc) throw new Error('Preview left its isolated origin');
    } catch {
      if (!loaded) return;
      done = true;
      cancel(timer);
      notify({ type: 'openmaic-preview-error' }, appOrigin);
    }
  };
  listen(frame, 'load', (event) => {
    if (event.isTrusted) inspect(true);
  });
  timer = setInterval(inspect, 100);
  // The workbench bounds readiness too; passive observation never renews access.
  setTimeout(() => {
    done = true;
    cancel(timer);
  }, 60_000);
}

export function previewShell(nonce) {
  return `<!doctype html><title>Application preview</title>
<style nonce="${nonce}">html,body{margin:0;width:100%;height:100%}iframe{width:100%;height:100%;border:0}#status{padding:1rem;font:14px sans-serif}</style>
<p id="status">Opening preview…</p><script nonce="${nonce}">
(()=>{'use strict';
const notifyFailure=parent.postMessage.bind(parent);
const controlled=new URL(location.href).searchParams.get('openmaic-input')==='1';
// Bootstrap callbacks remain executable, but the app must not inject new shell
// scripts using a copied nonce (including one exposed by CSP violation reports).
// Applied CSP policies intersect and cannot be relaxed by removing this meta.
const scriptSeal=document.createElement('meta');scriptSeal.httpEquiv='Content-Security-Policy';scriptSeal.content="script-src 'none'";document.head.append(scriptSeal);
let ticket=location.hash.slice(1);history.replaceState(null,'','/__openmaic_preview');
fetch('/__openmaic_authorize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})})
.then(async r=>{ticket='';if(!r.ok)throw Error();const {activityKey,appOrigin,standaloneDocument}=await r.json();const documentPath=standaloneDocument===true?'/?__openmaic_document=1':'/';if(window.top===window){location.replace(documentPath);return;}if(typeof activityKey!=='string')throw Error();const frame=document.createElement('iframe');frame.title='Application';
const prepareDocument=(${installPreviewActivity.toString()})(frame,activityKey,appOrigin,controlled);
if(controlled)frame.style.visibility='hidden';
(${installPreviewReadiness.toString()})(frame,appOrigin,prepareDocument);frame.src=documentPath;document.getElementById('status').remove();document.body.append(frame);})
.catch(()=>{document.getElementById('status').textContent='Access expired. Reopen from OpenMAIC.';
// Before authorization there is no configured appOrigin. This static failure
// contains no credential or application data and cannot grant readiness/activity.
notifyFailure({type:'openmaic-preview-error'},'*');});})();</script>`;
}
