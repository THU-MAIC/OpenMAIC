import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { fetchModels } from '@/lib/server/model-fetch';

it('aborts a real stalled response body before succeeding on one retry', async () => {
  let requests = 0;
  let closedFirstResponse = false;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (requests === 1) {
      res.on('close', () => {
        closedFirstResponse = true;
      });
      res.write('{"data":['); // Headers and partial JSON arrive, but the body never ends.
    } else {
      res.end('{"data":[{"id":"recovered"}]}');
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    const started = Date.now();
    const models = await fetchModels(`http://127.0.0.1:${address.port}`, '');
    expect(models).toEqual([{ id: 'recovered', ownedBy: undefined }]);
    expect(requests).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(14_900);
    await expect.poll(() => closedFirstResponse).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 25_000);
