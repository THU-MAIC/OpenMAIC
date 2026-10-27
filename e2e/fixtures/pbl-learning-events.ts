import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test as base } from '@playwright/test';
import type { LearningSnapshot } from '@/lib/pbl/v3/event-stream';

/** Keep the real browser stream/parser while commands use each spec's mutable fixtures. */
export const test = base.extend<{
  learningEvents: (snapshot: () => LearningSnapshot) => Promise<() => void>;
}>({
  learningEvents: async ({ page }, use) => {
    const clients = new Set<ServerResponse>();
    let snapshot: (() => LearningSnapshot) | undefined;
    const send = (response: ServerResponse) => {
      if (snapshot && !response.destroyed)
        response.write(`event: learning\ndata: ${JSON.stringify(snapshot())}\n\n`);
    };
    const publish = () => clients.forEach(send);
    const server = createServer((request, response) => {
      response.setHeader('access-control-allow-origin', request.headers.origin ?? '*');
      response.setHeader('access-control-allow-headers', 'x-openmaic-sandbox');
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }
      if (request.headers['x-openmaic-sandbox'] !== '1') {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      clients.add(response);
      response.on('close', () => clients.delete(response));
      send(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const changed = (response: import('@playwright/test').Response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/pbl/v3') && path !== '/api/pbl/v3/events') publish();
    };
    page.on('response', changed);
    try {
      await use(async (readSnapshot) => {
        snapshot = readSnapshot;
        await page.route('**/api/pbl/v3/events?**', (route) =>
          route.continue({ url: `http://127.0.0.1:${port}/events` }),
        );
        return publish;
      });
    } finally {
      page.off('response', changed);
      for (const client of clients) client.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
});
