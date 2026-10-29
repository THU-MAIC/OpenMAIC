/** Optional stateless preview transport. No cloud key, database, course or model logic here. */
import http from 'node:http';
import https from 'node:https';
import {
  previewAuthorizationCookies,
  previewContentDisposition,
  validatePreviewTarget,
} from './sandbox-preview-policy.mjs';
import { previewShell } from './sandbox-preview-activity.mjs';
import { previewAgent } from './sandbox-preview-transport.mjs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const originPattern = process.env.OPENMAIC_SANDBOX_PREVIEW_ORIGIN;
const backend = process.env.OPENMAIC_PREVIEW_BACKEND_ORIGIN;
const gatewayKey = process.env.OPENMAIC_PREVIEW_GATEWAY_KEY;
const port = Number(process.env.OPENMAIC_PREVIEW_LISTEN_PORT ?? 3201);
if (
  !originPattern ||
  originPattern.split('{id}').length !== 2 ||
  !backend ||
  !gatewayKey ||
  gatewayKey.length < 32
)
  throw new Error('Configure preview origin, backend origin and gateway key.');
const example = new URL(originPattern.replace('{id}', '00000000-0000-4000-8000-000000000000'));
const backendUrl = new URL('/api/sandbox/preview/resolve', backend);
if (
  backendUrl.username ||
  backendUrl.password ||
  !(
    backendUrl.protocol === 'https:' ||
    (backendUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(backendUrl.hostname))
  )
)
  throw new Error('Preview backend requires HTTPS or loopback HTTP.');
const secure = example.protocol === 'https:';
if (!secure && !(example.protocol === 'http:' && example.hostname.endsWith('.localhost')))
  throw new Error('Public previews require HTTPS.');
const cookieName = secure ? '__Host-openmaic_preview' : 'openmaic_preview';
const maxBody = 16 * 1024 * 1024;
const hop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
function hostOf(req) {
  const host = req.headers.host ?? '';
  const id = host.split('.')[0];
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
    new URL(originPattern.replace('{id}', id)).host !== host
  )
    throw new Error('Invalid preview host');
  return host;
}
function token(req) {
  const matches = (req.headers.cookie ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.startsWith(cookieName + '='));
  if (matches.length !== 1) throw new Error('Preview authorization required');
  return matches[0].slice(cookieName.length + 1);
}
function activityKey(ticket, host) {
  return createHmac('sha256', gatewayKey)
    .update('preview-activity-v1:' + host + ':' + ticket)
    .digest('base64url');
}
// Each request and WebSocket upgrade rechecks the current grant epoch.
// Reusing a recently resolved target would allow writes after revocation.
class PreviewResolveError extends Error {
  constructor(statusCode) {
    super('Preview resolution failed.');
    this.statusCode = statusCode;
  }
}
async function resolve(ticket, host, activity = false) {
  const body = JSON.stringify({ ticket, host, ...(activity ? { activity: true } : {}) });
  const at = String(Date.now());
  const auth =
    at +
    '.' +
    createHmac('sha256', gatewayKey)
      .update(at + '.' + body)
      .digest('hex');
  let r;
  try {
    r = await fetch(backendUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'x-openmaic-preview-gateway': auth },
      body,
    });
  } catch {
    throw new PreviewResolveError(503);
  }
  if (!r.ok) throw new PreviewResolveError(r.status >= 500 || r.status === 429 ? r.status : 403);
  try {
    const target = await r.json();
    validatePreviewTarget(target);
    return target;
  } catch {
    throw new PreviewResolveError(502);
  }
}
function watchAuthorization(ticket, host, close) {
  let stopped = false,
    pending = false;
  const interval = setInterval(async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      await resolve(ticket, host);
    } catch {
      if (!stopped) close();
    } finally {
      pending = false;
    }
  }, 5000);
  interval.unref();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
function headersFor(req, target, upgrade = false) {
  const headers = {};
  const dynamic = new Set(
    String(req.headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((x) => x.trim()),
  );
  for (const [k, v] of Object.entries(req.headers)) {
    if (
      hop.has(k) ||
      dynamic.has(k) ||
      k === 'host' ||
      k === 'cookie' ||
      k === 'origin' ||
      k === 'referer' ||
      k === 'forwarded' ||
      k.startsWith('x-forwarded-') ||
      k.startsWith('x-openmaic-') ||
      k === 'e2b-traffic-access-token' ||
      k === 'x-access-token'
    )
      continue;
    headers[k] = v;
  }
  const cookies = (req.headers.cookie ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith(cookieName + '='));
  if (cookies.length) headers.cookie = cookies.join('; ');
  headers.host = new URL(target.url).host;
  if (req.headers.origin) headers.origin = new URL(target.url).origin;
  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }
  if (target.transport === 'native')
    headers['e2b-traffic-access-token'] = target.headers['e2b-traffic-access-token'];
  return headers;
}
function responseHeaders(incoming, target, host) {
  const headers = {};
  const dynamic = new Set(
    String(incoming.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((x) => x.trim()),
  );
  for (const [k, v] of Object.entries(incoming)) {
    if (
      hop.has(k) ||
      dynamic.has(k) ||
      k === 'e2b-traffic-access-token' ||
      k === 'x-access-token' ||
      k === 'set-cookie' ||
      k === 'location' ||
      k === 'clear-site-data' ||
      k === 'access-control-allow-origin' ||
      k === 'access-control-allow-credentials' ||
      k === 'service-worker-allowed'
    )
      continue;
    headers[k] = v;
  }
  headers['cache-control'] = 'no-store';
  if (headers['content-disposition'])
    headers['content-disposition'] = previewContentDisposition(
      target.transport,
      incoming['content-type'],
      headers['content-disposition'],
    );
  headers['referrer-policy'] = 'no-referrer';
  headers['x-content-type-options'] = 'nosniff';
  if (incoming.location) {
    const next = new URL(incoming.location, target.url);
    if (next.origin !== new URL(target.url).origin)
      throw new Error('External preview redirect refused');
    headers.location = example.protocol + '//' + host + next.pathname + next.search + next.hash;
  }
  if (incoming['set-cookie'])
    headers['set-cookie'] = incoming['set-cookie']
      .filter((c) => c.split('=', 1)[0].trim() !== cookieName)
      .map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
  return headers;
}
function checkOrigin(req, host, upgrade = false) {
  if (
    (upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) &&
    req.headers.origin !== example.protocol + '//' + host
  )
    throw new Error('Cross-origin preview mutation refused');
}
function fail(res, status = 403) {
  if (!res.headersSent)
    res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end(
    status === 429
      ? 'Preview connection limit reached. Close unused previews and retry.'
      : status >= 500
        ? 'Preview temporarily unavailable. Please retry.'
        : 'Preview unavailable or access expired. Reopen it from OpenMAIC.',
  );
}
const server = http.createServer(async (req, res) => {
  try {
    const host = hostOf(req);
    const path = new URL(req.url, example.origin);
    if (
      req.headers['sec-fetch-dest'] === 'serviceworker' ||
      req.headers['service-worker'] === 'script'
    )
      throw new Error('Preview service workers are disabled');
    if (path.pathname === '/__openmaic_preview' && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors *`,
      });
      res.end(previewShell(nonce));
      return;
    }
    if (path.pathname === '/__openmaic_authorize') {
      checkOrigin(req, host);
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json'))
        throw new Error('Invalid exchange');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) throw new Error('Body limit');
        chunks.push(chunk);
      }
      const { ticket } = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof ticket !== 'string' || ticket.length > 4096 || !/^[-_a-zA-Z0-9.]+$/.test(ticket))
        throw new Error('Invalid ticket');
      const target = await resolve(ticket, host);
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'set-cookie': previewAuthorizationCookies(cookieName, ticket, target.expiresAt),
      });
      // Bootstrap requires the raw signed ticket, never just the app's cookie.
      res.end(JSON.stringify({ activityKey: activityKey(ticket, host) }));
      return;
    }
    if (path.pathname === '/__openmaic_activity') {
      checkOrigin(req, host);
      if (req.method !== 'POST') throw new Error('Invalid activity signal');
      const ticket = token(req);
      const proof = req.headers['x-openmaic-preview-activity'];
      const expected = activityKey(ticket, host);
      if (
        typeof proof !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(proof) ||
        !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
      )
        throw new Error('Invalid activity capability');
      await resolve(ticket, host, true);
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    checkOrigin(req, host);
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method))
      throw new Error('Unsupported method');
    const ticket = token(req);
    const target = await resolve(ticket, host);
    // Use only path/query: a client request can never select the upstream host or port.
    const url = new URL(target.url);
    url.pathname = path.pathname;
    url.search = path.search;
    if (Number(req.headers['content-length'] ?? 0) > maxBody) {
      fail(res, 413);
      return;
    }
    const agent =
      target.transport === 'sdk'
        ? previewAgent({ backend, gatewayKey, ticket, host })
        : new https.Agent({ keepAlive: false, maxSockets: 1 });
    const upstream = (target.transport === 'native' ? https : http).request(
      url,
      { method: req.method, headers: headersFor(req, target), timeout: 30_000, agent },
      (reply) => {
        try {
          res.writeHead(reply.statusCode ?? 502, responseHeaders(reply.headers, target, host));
          reply.pipe(res);
        } catch {
          reply.destroy();
          fail(res, 502);
        }
      },
    );
    const timer = setTimeout(
      () => upstream.destroy(),
      Math.max(1, Math.min(120_000, target.expiresAt - Date.now())),
    );
    let sent = 0;
    req.on('data', (chunk) => {
      sent += chunk.length;
      if (sent > maxBody) {
        upstream.destroy();
        fail(res, 413);
      }
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', (error) => fail(res, error.statusCode === 429 ? 429 : 502));
    const cancelWatch = watchAuthorization(ticket, host, () => upstream.destroy());
    res.on('close', () => {
      cancelWatch();
      clearTimeout(timer);
      upstream.destroy();
      agent.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  } catch (error) {
    fail(res, error instanceof PreviewResolveError ? error.statusCode : 403);
  }
});
server.on('upgrade', async (req, socket, head) => {
  let upstream;
  let timer;
  try {
    const host = hostOf(req);
    checkOrigin(req, host, true);
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') throw new Error('Invalid upgrade');
    const ticket = token(req);
    const target = await resolve(ticket, host);
    if (socket.destroyed) return;
    const path = new URL(req.url, example.origin);
    const url = new URL(target.url);
    url.pathname = path.pathname;
    url.search = path.search;
    const agent =
      target.transport === 'sdk'
        ? previewAgent({ backend, gatewayKey, ticket, host })
        : new https.Agent({ keepAlive: false, maxSockets: 1 });
    upstream = (target.transport === 'native' ? https : http).request(url, {
      headers: headersFor(req, target, true),
      timeout: 30_000,
      agent,
    });
    socket.on('close', () => agent.destroy());
    upstream.on('upgrade', (reply, remote, remoteHead) => {
      try {
        const headers = responseHeaders(reply.headers, target, host);
        headers.connection = 'Upgrade';
        headers.upgrade = 'websocket';
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            Object.entries(headers)
              .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}\r\n`))
              .join('') +
            '\r\n',
        );
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        socket.pipe(remote);
        remote.pipe(socket);
        // Revocation is bounded even for existing WS sessions; clients reconnect through authorization.
        timer = setTimeout(
          () => {
            remote.destroy();
            socket.destroy();
          },
          Math.max(1, Math.min(60_000, target.expiresAt - Date.now())),
        );
        remote.on('error', () => socket.destroy());
        remote.on('close', () => socket.destroy());
        const cancelWatch = watchAuthorization(ticket, host, () => {
          remote.destroy();
          socket.destroy();
        });
        socket.on('close', () => {
          cancelWatch();
          clearTimeout(timer);
          remote.destroy();
        });
      } catch {
        remote.destroy();
        socket.destroy();
      }
    });
    upstream.on('response', (reply) => {
      reply.destroy();
      socket.destroy();
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  } catch (error) {
    const status = error instanceof PreviewResolveError ? error.statusCode : 403;
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
  }
});
server.headersTimeout = 15_000;
server.requestTimeout = 120_000;
server.listen(port, process.env.OPENMAIC_PREVIEW_LISTEN_HOST ?? '127.0.0.1', () =>
  console.log(`Sandbox preview gateway listening on ${port}`),
);
