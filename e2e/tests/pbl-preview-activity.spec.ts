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

test('only trusted preview input can use the private activity capability', async ({ page }) => {
  test.setTimeout(60000);
  let signals = 0;
  const sockets = new Set<Socket>();
  const pending = new Set<ServerResponse>();
  const app = createServer((req, res) => {
    if (req.url === '/pending-image') {
      pending.add(res);
      res.on('close', () => pending.delete(res));
      return;
    }
    res.setHeader('content-type', 'text/html');
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
Promise.all([
 fetch('/__openmaic_activity',{method:'POST'}).then(r=>r.status),
 fetch('/__openmaic_authorize',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)
]).then(codes=>document.querySelector('output').textContent=codes.join(','));
</script>`);
  });
  const appPort = await listen(app);
  const backend = createServer(async (req, res) => {
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
    if (JSON.parse(text).activity === true) signals++;
    res.setHeader('content-type', 'application/json');
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
    await page.goto(origin + '/__openmaic_preview#test-only-grant', {
      waitUntil: 'domcontentloaded',
    });
    const frame = page.frameLocator('iframe[title="Application"]');
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
