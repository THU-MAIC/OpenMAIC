/** Keep the gateway shell separate from course HTML: no response rewriting or app instrumentation. */
export function installPreviewActivity(frame) {
  let changed = false;
  let pending = false;
  let next = 0;
  let timer;
  const flush = async () => {
    clearTimeout(timer);
    if (!changed || pending || document.visibilityState !== 'visible') return;
    if (Date.now() < next) {
      timer = setTimeout(flush, next - Date.now());
      return;
    }
    changed = false;
    pending = true;
    next = Date.now() + 30_000;
    try {
      const response = await fetch('/__openmaic_activity', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok && response.status !== 403) changed = true;
    } catch {
      changed = true;
    } finally {
      pending = false;
      if (changed) void flush();
    }
  };
  const input = (event) => {
    if (!event.isTrusted || document.visibilityState !== 'visible') return;
    changed = true;
    void flush();
  };
  frame.addEventListener('load', () => {
    // The protected app and this shell share only the isolated preview origin.
    // Cross-origin navigation is not an activity signal.
    try {
      for (const name of ['pointerdown', 'keydown', 'wheel'])
        frame.contentDocument?.addEventListener(name, input, { capture: true, passive: true });
    } catch {}
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flush();
    else clearTimeout(timer);
  });
}

export function previewShell(nonce) {
  return `<!doctype html><title>Application preview</title>
<style nonce="${nonce}">html,body{margin:0;width:100%;height:100%}iframe{width:100%;height:100%;border:0}#status{padding:1rem;font:14px sans-serif}</style>
<p id="status">Opening preview…</p><script nonce="${nonce}">
let ticket=location.hash.slice(1);history.replaceState(null,'','/__openmaic_preview');
fetch('/__openmaic_authorize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})})
.then(r=>{ticket='';if(!r.ok)throw Error();const frame=document.createElement('iframe');frame.title='Application';
(${installPreviewActivity.toString()})(frame);frame.src='/';document.getElementById('status').remove();document.body.append(frame);})
.catch(()=>{document.getElementById('status').textContent='Access expired. Reopen from OpenMAIC.'});</script>`;
}
