/**
 * `FetchEventSource` against the browser's own `EventSource`: the same streams,
 * over a real connection, must look the same to a listener and to the server.
 * Needs nothing from the app, so the page is served here.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import ts from 'typescript';
import { SSE_CASES } from '../../tests/utils/sse-cases';

type Seen = { lastId: string | null; cookie: string | null; closed: boolean };
const requests = new Map<string, Seen[]>();
const SSE = { 'content-type': 'text/event-stream', 'cache-control': 'no-store' };
const client = ts.transpileModule(
  readFileSync(resolve(__dirname, '../../lib/utils/fetch-event-source.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
let servers: Server[] = [];
let origin = '';
let otherOrigin = '';

const handler: Parameters<typeof createServer>[1] = (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const route = url.pathname;
  if (route === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'c=1; SameSite=Lax' });
    return void res.end('<!doctype html><title>parity</title>');
  }
  if (route === '/client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return void res.end(client);
  }
  const key = url.searchParams.get('key') ?? '';
  const seen = requests.get(key) ?? [];
  requests.set(key, seen);
  const attempt = seen.length;
  const entry: Seen = {
    // Node reads header bytes as Latin-1, so this is what went over the wire.
    lastId: (req.headers['last-event-id'] as string | undefined) ?? null,
    cookie: req.headers.cookie ?? null,
    closed: false,
  };
  seen.push(entry);
  res.on('close', () => (entry.closed = true));
  const later = () => {
    res.writeHead(204);
    res.end();
  };
  switch (route) {
    case '/case': {
      res.writeHead(200, SSE);
      const body = Buffer.from(SSE_CASES[Number(url.searchParams.get('index'))]!.body);
      if (url.searchParams.get('bytes') !== '1') return void res.end(body);
      void (async () => {
        for (const byte of body) {
          res.write(Buffer.of(byte));
          await new Promise((done) => setTimeout(done, 1));
        }
        res.end();
      })();
      return;
    }
    case '/status': {
      const type = url.searchParams.get('type');
      res.writeHead(Number(url.searchParams.get('code')), type ? { 'content-type': type } : {});
      return void res.end(url.searchParams.get('code') === '204' ? undefined : 'data: x\n\n');
    }
    case '/redirect':
      res.writeHead(302, { location: `${url.searchParams.get('to')}/status?code=200&key=${key}x` });
      return void res.end();
    case '/resume':
      if (attempt === 0) {
        res.writeHead(200, SSE);
        return void res.end(
          `retry: 1000\nid: ${url.searchParams.get('id')}\ndata: a\n\ndata: lost\n`,
        );
      }
      if (attempt > 1) return later();
      res.writeHead(200, SSE);
      return void res.end('data: b\n\n');
    case '/cut':
      if (attempt > 0) return later();
      res.writeHead(200, SSE);
      res.write('retry: 1000\nid: 1\ndata: a\n\n');
      return void setTimeout(() => req.socket.destroy(), 50);
    case '/refuse-socket':
      return attempt === 0 ? void req.socket.destroy() : later();
    case '/hold':
      res.writeHead(200, SSE);
      return void res.write('data: a\n\n');
    default:
      res.writeHead(404);
      res.end();
  }
};

const listen = (server: Server) =>
  new Promise<string>((done) =>
    server.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }),
  );

test.beforeAll(async () => {
  servers = [createServer(handler), createServer(handler)];
  origin = await listen(servers[0]!);
  otherOrigin = await listen(servers[1]!);
});
test.afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});
test.beforeEach(async ({ page }) => {
  await page.goto(origin);
  await page.evaluate(
    `import('/client.js').then((m) => (window.__fetchSource = m.FetchEventSource))`,
  );
});

/** Every event until `stopAfter` errors have fired, the source closed, or `limit` ms passed. */
function observe(page: Page, kind: string, url: string, stopAfter: number, limit: number) {
  return page.evaluate(
    async ({ kind, url, stopAfter, limit }) => {
      const scope = window as unknown as Record<string, new (url: string) => EventSource>;
      const source = new scope[kind === 'native' ? 'EventSource' : '__fetchSource']!(url);
      const seen: unknown[] = [];
      let errors = 0;
      await new Promise<void>((done) => {
        setTimeout(done, limit);
        for (const type of ['open', 'message', 'x', 'error']) {
          source.addEventListener(type, (event) => {
            const { data, lastEventId } = event as MessageEvent;
            seen.push([type, data ?? null, lastEventId ?? null, source.readyState]);
            if (type === 'error' && (++errors >= stopAfter || source.readyState === 2)) done();
          });
        }
      });
      source.close();
      return seen;
    },
    { kind, url, stopAfter, limit },
  );
}

let run = 0;
async function compare(page: Page, path: string, stopAfter = 1, limit = 6_000) {
  const results = [];
  for (const kind of ['native', 'fetch']) {
    const key = `run-${run++}`;
    const url = `${path}${path.includes('?') ? '&' : '?'}key=${key}`;
    const events = await observe(page, kind, url, stopAfter, limit);
    const seen = (requests.get(key) ?? []).map(({ lastId, cookie }) => ({ lastId, cookie }));
    results.push({ events, requests: seen.slice(0, stopAfter) });
  }
  expect(results[1]).toEqual(results[0]);
  return results[0]!;
}

test.describe('FetchEventSource parity with EventSource', () => {
  SSE_CASES.forEach(({ name }, index) => {
    test(name, async ({ page }) => {
      await compare(page, `/case?index=${index}`);
    });
    test(`${name}, byte by byte`, async ({ page }) => {
      await compare(page, `/case?index=${index}&bytes=1`);
    });
  });

  for (const [name, query] of [
    ['204', 'code=204'],
    ['404', 'code=404'],
    ['500', 'code=500'],
    ['201', 'code=201&type=text/event-stream'],
    ['the wrong type', 'code=200&type=application/json'],
    ['no type', 'code=200'],
    ['a type with parameters', `code=200&type=${encodeURIComponent('Text/Event-Stream; a=b')}`],
  ]) {
    test(`a response with ${name}`, async ({ page }) => {
      await compare(page, `/status?${query}`, 1, 800);
    });
  }

  test('a same-origin redirect is followed', async ({ page }) => {
    await compare(page, `/redirect?to=${encodeURIComponent(origin)}`, 1, 800);
  });

  test('a cross-origin redirect without CORS closes the source', async ({ page }) => {
    const { events } = await compare(page, `/redirect?to=${encodeURIComponent(otherOrigin)}`);
    expect(events).toEqual([['error', null, null, 2]]);
  });

  test('a reconnect resumes from the last id, dropping a partial frame', async ({ page }) => {
    const { requests: seen } = await compare(page, '/resume?id=7', 2);
    expect(seen[1]!.lastId).toBe('7');
    expect(seen[1]!.cookie).toBe('c=1');
  });

  test('a non-ASCII id goes over the wire as the same bytes', async ({ page }) => {
    const id = '课堂';
    const { requests: seen } = await compare(page, `/resume?id=${encodeURIComponent(id)}`, 2);
    expect(Buffer.from(seen[1]!.lastId!, 'latin1').toString('utf8')).toBe(id);
  });

  test('a connection cut mid-stream reconnects', async ({ page }) => {
    await compare(page, '/cut', 2);
  });

  test('a connection cut before the response retries', async ({ page }) => {
    await compare(page, '/refuse-socket', 1, 800);
  });

  test('close() reaches the server', async ({ page }) => {
    for (const kind of ['native', 'fetch']) {
      const key = `close-${kind}`;
      await observe(page, kind, `/hold?key=${key}`, 1, 200);
      await expect.poll(() => requests.get(key)?.[0]?.closed).toBe(true);
    }
  });
});
