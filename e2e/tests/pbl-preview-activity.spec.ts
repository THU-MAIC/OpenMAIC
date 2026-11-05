import { previewShell } from '../../scripts/sandbox-preview-activity.mjs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect } from '@playwright/test';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

test('keeps embedded activity private and new-tab applications genuinely top-level', async ({
  page,
}) => {
  test.setTimeout(60000);
  let signals = 0;
  let standalone = false;
  let pinned = false;
  let requireFreshGrant = false;
  let proxiedWorkers = 0;
  const sockets = new Set<Socket>();
  const pending = new Set<ServerResponse>();
  const app = createServer(async (req, res) => {
    if (
      req.url === '/?case=get' ||
      req.url === '/?case=relative' ||
      (req.method === 'POST' && req.url === '/')
    ) {
      let body = '';
      for await (const chunk of req) body += String(chunk);
      res.setHeader('content-type', 'text/plain');
      res.end(`${req.method} ${req.url} ${body}`.trim());
      return;
    }
    if (req.url === '/?check=api') {
      res.setHeader('content-type', 'application/json');
      res.end('{"root":true}');
      return;
    }
    if (req.url === '/worker.js') {
      proxiedWorkers++;
      res.setHeader('content-type', 'application/javascript');
      res.end(
        "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(clients.claim()));",
      );
      return;
    }
    if (req.url === '/pending-image') {
      pending.add(res);
      res.on('close', () => pending.delete(res));
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (standalone) {
      res.setHeader('content-security-policy', "frame-ancestors 'none'");
      res.end(`<!doctype html><h1>Standalone application</h1><output id="mode"></output><output id="worker"></output>
<script>
document.querySelector('#mode').textContent=window.top===window?'top-level':'framed';
navigator.serviceWorker.register('/worker.js',{scope:'/'}).then(()=>document.querySelector('#worker').textContent='registered',()=>document.querySelector('#worker').textContent='blocked');
</script>`);
      return;
    }
    res.end(`<!doctype html><input aria-label="Task"><output>Starting</output><img src="/pending-image">
<script>
window.stolen=0;window.callbacks=[];
const originalFetch=parent.fetch.bind(parent);
parent.fetch=(...args)=>{window.stolen++;return originalFetch(...args)};
const originalListen=parent.EventTarget.prototype.addEventListener;
parent.EventTarget.prototype.addEventListener=function(name,callback,options){
 if(['pointerdown','keydown','wheel'].includes(name))window.callbacks.push(callback);
 return Reflect.apply(originalListen,this,[name,callback,options]);
};
const iterator=parent.Headers.prototype[Symbol.iterator];
parent.Headers.prototype[Symbol.iterator]=function(){window.stolen++;return Reflect.apply(iterator,this,[])};
Object.defineProperty(parent.Response.prototype,'status',{configurable:true,get(){return 503}});
const nativeThen=parent.Promise.prototype.then;
Object.defineProperty(parent.Promise.prototype,'constructor',{configurable:true,value:function OtherPromise(){}});
parent.Promise.prototype.then=function(resolve,reject){
 const fulfilled=typeof resolve==='function'?value=>resolve(value instanceof parent.Response?new parent.Response(null,{status:503}):value):resolve;
 return Reflect.apply(nativeThen,this,[fulfilled,reject]);
};
Promise.all([
 fetch('/__openmaic_activity',{method:'POST'}).then(r=>r.status),
 fetch('/__openmaic_authorize',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)
]).then(codes=>document.querySelector('output').textContent=codes.join(','));
</script>`);
  });
  const appPort = await listen(app);
  const backend = createServer(async (req, res) => {
    if (req.url === '/host') {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<iframe title="Preview" src="${origin}/__openmaic_preview#test-only-grant"></iframe>`,
      );
      return;
    }
    if (req.url?.endsWith('/tunnel')) {
      const socket = connect(appPort, '127.0.0.1');
      sockets.add(socket);
      socket.on('error', () => res.destroy());
      socket.on('close', () => sockets.delete(socket));
      res.on('close', () => socket.destroy());
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(Buffer.from([1]));
      req.pipe(socket);
      socket.pipe(res);
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const request = JSON.parse(text);
    if (requireFreshGrant && request.ticket !== 'fresh-test-grant') {
      res.writeHead(403).end();
      return;
    }
    if (request.activity === true) signals++;
    res.setHeader('content-type', 'application/json');
    if (pinned && request.document === true) {
      res.end(
        JSON.stringify({
          transport: 'document',
          appOrigin: 'http://' + req.headers.host,
          html: `<h1>Pinned application</h1><output></output>
<form><input type="hidden" name="case" value="get"><button>Implicit GET</button></form>
<form method="post"><input type="hidden" name="case" value="post"><button>Implicit POST</button></form>
<form action="?case=relative" method="post"><button>Relative POST</button></form>
<script>fetch("/?check=api").then(r=>r.json()).then(r=>document.querySelector("output").textContent=String(r.root))</script>`,
          expiresAt: Date.now() + 60000,
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        transport: 'sdk',
        url: `http://127.0.0.1:${appPort}`,
        expiresAt: Date.now() + 60000,
      }),
    );
  });
  const backendPort = await listen(backend);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://00000000-0000-4000-8000-000000000000.localhost:${port}`;
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['scripts/sandbox-preview-gateway.mjs'], {
      env: {
        ...process.env,
        OPENMAIC_SANDBOX_PREVIEW_ORIGIN: `http://{id}.localhost:${port}`,
        OPENMAIC_PREVIEW_BACKEND_ORIGIN: `http://127.0.0.1:${backendPort}`,
        OPENMAIC_PREVIEW_GATEWAY_KEY: 'test-only-activity-isolation-key'.repeat(2),
        OPENMAIC_PREVIEW_LISTEN_PORT: String(port),
        OPENMAIC_PREVIEW_LISTEN_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.on('data', (data) => {
        if (String(data).includes('listening')) resolve();
      });
      child!.once('error', reject);
      child!.once('exit', (code) => reject(new Error(`Gateway exited: ${code}`)));
    });
    await page.clock.install({ time: Date.now() });
    await page.goto(`http://127.0.0.1:${backendPort}/host`, {
      waitUntil: 'domcontentloaded',
    });
    const frame = page
      .frameLocator('iframe[title="Preview"]')
      .frameLocator('iframe[title="Application"]');
    await expect(frame.locator('output')).toHaveText('403,403');
    await page.clock.runFor(200);
    expect(signals).toBe(0);
    expect(await frame.locator('body').evaluate(() => document.readyState)).toBe('interactive');
    await frame.getByRole('textbox', { name: 'Task' }).dispatchEvent('keydown', { key: 'a' });
    expect(signals).toBe(0);
    await frame.getByRole('textbox', { name: 'Task' }).click();
    await expect.poll(() => signals).toBe(1);
    await frame.getByRole('textbox', { name: 'Task' }).pressSequentially('real input');
    await page.clock.runFor(31000);
    await expect.poll(() => signals).toBe(2);
    await page.clock.runFor(31000);
    expect(signals).toBe(2); // Response/status hooks cannot force endless retries.
    expect(
      await frame.locator('body').evaluate(() => (window as unknown as { stolen: number }).stolen),
    ).toBe(0);
    // Browser tooling may register other listeners. Try every intercepted
    // callback: none may give app code the trusted activity callback.
    await frame.locator('body').evaluate(() => {
      const callbacks = (window as unknown as { callbacks: ((event: object) => void)[] }).callbacks;
      for (const callback of callbacks) {
        try {
          callback({
            isTrusted: true,
            type: 'keydown',
            key: 'x',
            target: document.querySelector('input'),
          });
        } catch {
          /* An unrelated listener can require more event fields. */
        }
      }
    });
    await page.clock.runFor(31000);
    expect(signals).toBe(2);
    // A second authorized shell shares the cookie, but must not invalidate the first.
    await page.evaluate((src) => {
      const renewed = document.createElement('iframe');
      renewed.title = 'Renewed preview';
      renewed.src = src;
      document.body.append(renewed);
    }, origin + '/__openmaic_preview#renewed-test-only-grant');
    await expect(
      page
        .frameLocator('iframe[title="Renewed preview"]')
        .frameLocator('iframe[title="Application"]')
        .locator('output'),
    ).toHaveText('403,403');
    await frame.getByRole('textbox', { name: 'Task' }).click();
    await expect.poll(() => signals).toBe(3);
    // The new-tab fallback must also work for apps that explicitly refuse framing.
    standalone = true;
    await page.goto(origin + '/__openmaic_preview#test-only-grant', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('heading', { name: 'Standalone application' })).toBeVisible();
    await expect(page.locator('#mode')).toHaveText('top-level');
    await expect(page.locator('#worker')).toHaveText('blocked');
    expect(proxiedWorkers).toBe(0);
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    expect(page.url()).toBe(origin + '/');
    expect(page.frames()).toHaveLength(1);
    await page.clock.runFor(31000);
    expect(signals).toBe(3); // Standalone navigation is not a learner activity signal.
    pinned = true;
    await page.goto(origin + '/__openmaic_preview#test-only-grant', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('heading', { name: 'Pinned application' })).toBeVisible();
    await expect(page.locator('output')).toHaveText('true');
    expect(page.url()).toBe(origin + '/?__openmaic_document=1');
    expect(page.frames()).toHaveLength(1);
    await page.goto(`http://127.0.0.1:${backendPort}/host`, {
      waitUntil: 'domcontentloaded',
    });
    const pinnedFrame = page.frameLocator('iframe[title="Preview"]').frameLocator('iframe');
    await expect(pinnedFrame.getByRole('heading', { name: 'Pinned application' })).toBeVisible();
    await expect(pinnedFrame.locator('output')).toHaveText('true');
    const appOutput = pinnedFrame.locator('output');
    const denied = await appOutput.evaluate(
      async () =>
        (await fetch('/__openmaic_renew', { method: 'POST', body: 'fresh-test-grant' })).status,
    );
    expect(denied).toBe(403);
    await appOutput.evaluate((output) => output.setAttribute('data-preserved', 'true'));
    expect(
      await page.evaluate(
        async (previewOrigin) =>
          (
            await fetch(previewOrigin + '/__openmaic_renew', {
              method: 'POST',
              credentials: 'include',
              body: 'fresh-test-grant',
            })
          ).status,
        origin,
      ),
    ).toBe(200);
    requireFreshGrant = true;
    expect(await appOutput.evaluate(async () => (await fetch('/?check=api')).status)).toBe(200);
    await expect(appOutput).toHaveAttribute('data-preserved', 'true');
    expect(signals).toBe(3);
    requireFreshGrant = false;
    await pinnedFrame.getByRole('button', { name: 'Implicit GET' }).click();
    await expect(pinnedFrame.getByText('GET /?case=get')).toBeVisible();
    for (const [name, response] of [
      ['Implicit POST', 'POST / case=post'],
      ['Relative POST', 'POST /?case=relative'],
    ]) {
      await page.goto(origin + '/__openmaic_preview#test-only-grant', {
        waitUntil: 'domcontentloaded',
      });
      await page.getByRole('button', { name }).click();
      await expect(page.getByText(response)).toBeVisible();
    }
  } finally {
    await page.goto('about:blank').catch(() => {});
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    for (const res of pending) res.destroy();
    backend.closeAllConnections();
    app.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => backend.close(() => r())),
      new Promise<void>((r) => app.close(() => r())),
    ]);
  }
});

test('reports actual nested document readiness and rejects child claims or failed documents', async ({
  page,
}) => {
  const host = 'http://preview-host.test',
    gateway = 'http://preview-gateway.test';
  let mode = 'ready';
  let release!: () => void;
  const parser = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${host}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><script>
    window.accepted=[];window.rejected=0;addEventListener('message',event=>{
      if(event.origin!==${JSON.stringify(gateway)})return;
      if(event.source===document.querySelector('iframe').contentWindow)window.accepted.push(event.data.type);
      else window.rejected++;
    });</script><iframe src="${gateway}/__openmaic_preview#fixture"></iframe>`,
    }),
  );
  await page.route(`${gateway}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/__openmaic_preview')
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: previewShell('fixture-nonce'),
      });
    if (path === '/__openmaic_authorize')
      return mode === 'auth-error'
        ? route.fulfill({ status: 403 })
        : route.fulfill({ json: { activityKey: 'fixture-private-key', appOrigin: host } });
    if (path === '/pending-parser.js') {
      await parser;
      return route.fulfill({ contentType: 'text/javascript', body: '' });
    }
    if (mode === 'nested-error')
      return route.fulfill({ status: 403, contentType: 'text/plain', body: 'Access denied' });
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><p>Application document</p><script>
      parent.parent.postMessage({type:'openmaic-preview-ready'},${JSON.stringify(host)});
    </script><script src="/pending-parser.js"></script>`,
    });
  });
  try {
    await page.goto(host, { waitUntil: 'domcontentloaded' });
    await expect(
      page.frameLocator('iframe').frameLocator('iframe').getByText('Application document'),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { rejected: number }).rejected))
      .toBe(1);
    expect(
      await page.evaluate(() => (window as unknown as { accepted: string[] }).accepted),
    ).toEqual([]);
    release();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { accepted: string[] }).accepted))
      .toEqual(['openmaic-preview-ready']);
    for (mode of ['auth-error', 'nested-error']) {
      await page.goto(host, { waitUntil: 'domcontentloaded' });
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { accepted: string[] }).accepted))
        .toEqual(['openmaic-preview-error']);
    }
  } finally {
    release();
  }
});

test('seals shell script execution while preserving nested readiness, input and activity', async ({
  page,
}) => {
  const host = 'http://sealed-preview-host.test',
    gateway = 'http://sealed-preview-gateway.test';
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signals = 0;
  await page.route(`${host}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><script>
      window.accepted=[];addEventListener('message',event=>{
        const frame=document.querySelector('iframe');
        if(event.origin===${JSON.stringify(gateway)}&&event.source===frame.contentWindow)window.accepted.push(event.data);
      });
      window.enable=value=>document.querySelector('iframe').contentWindow.postMessage({type:'openmaic-preview-input',enabled:value},${JSON.stringify(gateway)});
    </script><iframe src="${gateway}/__openmaic_preview?openmaic-input=1#fixture"></iframe>`,
    }),
  );
  await page.route(`${gateway}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/__openmaic_preview')
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        headers: {
          'content-security-policy':
            "default-src 'none'; script-src 'nonce-fixture-nonce'; connect-src 'self'; frame-src 'self'; style-src 'nonce-fixture-nonce'; base-uri 'none'; frame-ancestors *",
        },
        body: previewShell('fixture-nonce'),
      });
    if (path === '/__openmaic_authorize')
      return route.fulfill({ json: { activityKey: 'fixture-private-key', appOrigin: host } });
    if (path === '/__openmaic_activity') {
      signals++;
      return route.fulfill({
        status: 204,
        headers: { 'x-openmaic-preview-expires-at': String(Date.now() + 300000) },
      });
    }
    if (path === '/pending-parser.js') {
      await pending;
      return route.fulfill({ contentType: 'text/javascript', body: '' });
    }
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><input aria-label="Application input"><output id="child-script">running</output><script>
      window.attacks=[];window.leakedNonce=null;
      const outer=parent.document;
      const inject=(nonce,label)=>{const script=outer.createElement('script');if(nonce)script.nonce=nonce;
        script.textContent='parent.postMessage({type:"openmaic-preview-ready",spoof:'+JSON.stringify(label)+'},'+JSON.stringify(${JSON.stringify(host)})+');';
        outer.body.append(script);window.attacks.push(label);};
      outer.addEventListener('securitypolicyviolation',event=>{
        const match=event.originalPolicy.match(/nonce-([^' ;]+)/);
        if(match&&!window.leakedNonce){window.leakedNonce=match[1];inject(match[1],'leaked-policy');}
      });
      inject(outer.querySelector('script[nonce]').nonce,'copied-script');
      inject(outer.querySelector('style[nonce]').nonce,'copied-style');
      inject(null,'nonce-less');
      const seal=outer.querySelector('meta[http-equiv="Content-Security-Policy"]');
      seal.content="script-src * 'unsafe-inline'";seal.remove();
      inject(outer.querySelector('script[nonce]').nonce,'removed-policy');
      setTimeout(()=>document.querySelector('#child-script').textContent='child callbacks work',10);
    </script><script src="/pending-parser.js"></script>`,
    });
  });
  try {
    await page.goto(host, { waitUntil: 'domcontentloaded' });
    const outer = page.frameLocator('iframe'),
      app = outer.frameLocator('iframe');
    await expect(app.locator('#child-script')).toHaveText('child callbacks work');
    await expect
      .poll(() =>
        app
          .locator('body')
          .evaluate(() => (window as unknown as { leakedNonce: string }).leakedNonce),
      )
      .toBe('fixture-nonce');
    expect(
      await app
        .locator('body')
        .evaluate(() => (window as unknown as { attacks: string[] }).attacks),
    ).toEqual(
      expect.arrayContaining([
        'copied-script',
        'copied-style',
        'nonce-less',
        'removed-policy',
        'leaked-policy',
      ]),
    );
    expect(
      await page.evaluate(() =>
        (window as unknown as { accepted: { type: string }[] }).accepted.filter(
          (x) => x.type === 'openmaic-preview-ready',
        ),
      ),
    ).toEqual([]);
    expect(
      await outer.locator('body').evaluate((element) => getComputedStyle(element).margin),
    ).toBe('0px');
    await expect(app.locator('html')).toHaveAttribute('inert', '');
    expect(signals).toBe(0);
    release();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { accepted: { type: string }[] }).accepted.filter(
            (x) => x.type === 'openmaic-preview-ready',
          ),
        ),
      )
      .toEqual([{ type: 'openmaic-preview-ready' }]);
    await page.evaluate(() =>
      (window as unknown as { enable: (value: boolean) => void }).enable(true),
    );
    await expect(app.locator('html')).not.toHaveAttribute('inert', '');
    // Nested app code cannot impersonate activity from the trusted workbench.
    await app
      .locator('body')
      .evaluate(() =>
        parent.postMessage({ type: 'openmaic-preview-host-activity' }, location.origin),
      );
    await outer.locator('body').evaluate(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          source: parent,
          origin: 'http://sealed-preview-host.test',
          data: { type: 'openmaic-preview-host-activity' },
        }),
      ),
    );
    expect(signals).toBe(0);
    await page.evaluate(
      (gateway) =>
        document
          .querySelector('iframe')!
          .contentWindow!.postMessage({ type: 'openmaic-preview-host-activity' }, gateway),
      gateway,
    );
    await expect.poll(() => signals).toBe(1);
    await app.getByRole('textbox').fill('usable child document');
    await app.getByRole('textbox').press('Enter');
    await expect.poll(() => signals).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { accepted: { type: string }[] }).accepted.some(
            (x) => x.type === 'openmaic-preview-activity',
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(() =>
      (window as unknown as { enable: (value: boolean) => void }).enable(false),
    );
    await expect(app.locator('html')).toHaveAttribute('inert', '');
    await expect(app.getByRole('textbox')).toHaveValue('usable child document');
    await page.evaluate(
      (gateway) =>
        document
          .querySelector('iframe')!
          .contentWindow!.postMessage({ type: 'openmaic-preview-host-activity' }, gateway),
      gateway,
    );
    expect(signals).toBe(1); // Paused/hidden documents cannot renew from host signals.
  } finally {
    release();
  }
});
