import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

// Real gateway HTTP exchange. Browser enforcement is separately exercised in the
// UI acceptance; fetch alone does not implement SameSite or partitioning rules.
describe.each(['http:', 'https:'])('preview cookie exchange (%s)', (protocol) => {
  let revoked = false;
  let activitySignals = 0;
  let backendStatus = 200;
  let disconnect = false;
  let malformedTarget = false;
  beforeEach(() => {
    revoked = false;
    activitySignals = 0;
    backendStatus = 200;
    disconnect = false;
    malformedTarget = false;
  });
  let backend: http.Server;
  let child: ChildProcess;
  let port: number;
  let host: string;
  let origin: string;
  beforeAll(async () => {
    backend = http.createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += String(chunk);
      if (disconnect) {
        req.socket.destroy();
        return;
      }
      if (backendStatus !== 200) {
        res.writeHead(backendStatus);
        res.end('backend-only diagnostic');
        return;
      }
      if (JSON.parse(text).activity === true && !revoked) activitySignals++;
      if (revoked) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (malformedTarget) {
        res.end('{}');
        return;
      }
      res.end(
        JSON.stringify({
          transport: 'native',
          url: 'https://sandbox.example.test',
          headers: { 'e2b-traffic-access-token': 'test-only-provider-token' },
          expiresAt: Date.now() + 60000,
        }),
      );
    });
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    const backendPort = (backend.address() as { port: number }).port;
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const suffix = protocol === 'http:' ? 'localhost' : 'preview.example.test';
    host = `00000000-0000-4000-8000-000000000000.${suffix}:${port}`;
    origin = `${protocol}//${host}`;
    child = spawn(process.execPath, ['scripts/sandbox-preview-gateway.mjs'], {
      env: {
        ...process.env,
        OPENMAIC_SANDBOX_PREVIEW_ORIGIN: `${protocol}//{id}.${suffix}:${port}`,
        OPENMAIC_PREVIEW_BACKEND_ORIGIN: `http://127.0.0.1:${backendPort}`,
        OPENMAIC_PREVIEW_GATEWAY_KEY: 'test-only-gateway-key'.repeat(3),
        OPENMAIC_PREVIEW_LISTEN_HOST: '127.0.0.1',
        OPENMAIC_PREVIEW_LISTEN_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (data) => {
        if (String(data).includes('listening')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Gateway exited: ${code}`)));
    });
  });
  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    if (backend) await new Promise<void>((resolve) => backend.close(() => resolve()));
  });
  const request = (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<{ status: number; headers: Headers; body: string }>((resolve, reject) => {
      // Preserve the configured virtual Host while connecting to the loopback listener.
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: init.method ?? 'GET',
          headers: { host, origin, ...init.headers },
        },
        (res) => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
          }
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.once('end', () => resolve({ status: res.statusCode!, headers, body }));
        },
      );
      req.once('error', reject);
      req.end(init.body);
    });
  it('sets cross-site partitioned credentials without exposing provider credentials', async () => {
    const r = await request('/__openmaic_authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'test-only-signed-ticket' }),
    });
    expect(r.status).toBe(200);
    const c = r.headers.get('set-cookie')!;
    expect(c).toContain('Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=');
    expect(c).not.toContain('Domain=');
    expect(c).not.toContain('SameSite=Lax');
    expect(c).not.toContain('provider-token');
    expect(
      c.startsWith(protocol === 'https:' ? '__Host-openmaic_preview=' : 'openmaic_preview='),
    ).toBe(true);
  });
  it('rejects new POST and WebSocket upgrade immediately after a warm grant is revoked', async () => {
    const r = await request('/__openmaic_authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'warm-grant' }),
    });
    expect(r.status).toBe(200);
    const cookie = r.headers.getSetCookie().at(-1)!.split(';')[0];
    revoked = true; // No 3-second delay: the next request must consult the backend.
    expect((await request('/write', { method: 'POST', headers: { cookie } })).status).toBe(403);
    expect(
      (await request('/ws', { headers: { cookie, connection: 'Upgrade', upgrade: 'websocket' } }))
        .status,
    ).toBe(403);
  });
  it('reports only explicit protected preview input, not passive resolve requests', async () => {
    const authorized = await request('/__openmaic_authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'input-grant' }),
    });
    expect(activitySignals).toBe(0);
    const cookie = authorized.headers.getSetCookie().at(-1)!.split(';')[0];
    const proof = JSON.parse(authorized.body).activityKey;
    const headers = { cookie, 'x-openmaic-preview-activity': proof };
    // A framed app has the cookie but neither the raw bootstrap ticket nor its capability.
    expect(
      (await request('/__openmaic_activity', { method: 'POST', headers: { cookie } })).status,
    ).toBe(403);
    expect(
      (
        await request('/__openmaic_activity', {
          method: 'POST',
          headers: { ...headers, 'x-openmaic-preview-activity': 'x'.repeat(43) },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/__openmaic_authorize', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(activitySignals).toBe(0);
    expect((await request('/__openmaic_activity', { method: 'POST', headers })).status).toBe(204);
    expect(activitySignals).toBe(1);
    expect(
      (
        await request('/__openmaic_activity', {
          method: 'POST',
          headers: { ...headers, origin: 'https://foreign.example' },
        })
      ).status,
    ).toBe(403);
    expect((await request('/__openmaic_activity', { headers: { cookie } })).status).toBe(403);
    expect((await request('/__openmaic_activity', { method: 'POST' })).status).toBe(403);
    revoked = true;
    expect((await request('/__openmaic_activity', { method: 'POST', headers })).status).toBe(403);
    expect(activitySignals).toBe(1);
  });
  it('still refuses unauthenticated document requests and foreign-origin exchange', async () => {
    expect((await request('/')).status).toBe(403);
    const r = await request('/__openmaic_authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://foreign.example' },
      body: JSON.stringify({ ticket: 'test-only-signed-ticket' }),
    });
    expect(r.status).toBe(403);
    expect(r.headers.get('set-cookie')).toBeNull();
  });
  it.each([429, 500, 502, 503, 504])(
    'preserves HTTP %s so failed input can retry',
    async (status) => {
      const authorized = await request('/__openmaic_authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: 'retry-grant' }),
      });
      const cookie = authorized.headers.getSetCookie().at(-1)!.split(';')[0];
      const headers = {
        cookie,
        'x-openmaic-preview-activity': JSON.parse(authorized.body).activityKey,
      };
      backendStatus = status;
      expect((await request('/__openmaic_activity', { method: 'POST', headers })).status).toBe(
        status,
      );
      expect(activitySignals).toBe(0);
      expect(
        (await request('/ws', { headers: { cookie, connection: 'Upgrade', upgrade: 'websocket' } }))
          .status,
      ).toBe(status);
      backendStatus = 200;
      expect((await request('/__openmaic_activity', { method: 'POST', headers })).status).toBe(204);
      expect(activitySignals).toBe(1);
    },
  );
  it('fails closed with retryable status for network or invalid backend responses', async () => {
    const authorized = await request('/__openmaic_authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'network-grant' }),
    });
    const headers = {
      cookie: authorized.headers.getSetCookie().at(-1)!.split(';')[0],
      'x-openmaic-preview-activity': JSON.parse(authorized.body).activityKey,
    };
    disconnect = true;
    expect((await request('/__openmaic_activity', { method: 'POST', headers })).status).toBe(503);
    disconnect = false;
    malformedTarget = true;
    expect((await request('/__openmaic_activity', { method: 'POST', headers })).status).toBe(502);
    expect(activitySignals).toBe(1);
  });
});
