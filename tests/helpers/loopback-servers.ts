/**
 * Loopback HTTP servers and DNS answer stand-ins for tests that drive the real
 * SSRF guard and the pinned provider transport.
 *
 * Tests mock `node:dns` themselves (the mock must be hoisted in the test file)
 * and use {@link answerWith} for the callback-style connect-time lookup.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type DnsAnswer = { address: string; family: number };

export const PUBLIC_ANSWER: DnsAnswer[] = [{ address: '93.184.216.34', family: 4 }];
export const LOOPBACK_ANSWER: DnsAnswer[] = [{ address: '127.0.0.1', family: 4 }];

/** A callback-style `dns.lookup` stand-in that always returns `addresses`. */
export function answerWith(addresses: DnsAnswer[]) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ): void => {
    if (options?.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0]!.address, addresses[0]!.family);
    }
  };
}

export interface LoopbackServer {
  port: number;
  origin: string;
  requests: () => number;
  lastUrl: () => string | undefined;
  lastMethod: () => string | undefined;
  lastHeaders: () => IncomingMessage['headers'] | undefined;
  lastBody: () => Buffer | undefined;
}

const servers: Server[] = [];

/**
 * Start a loopback server. The request body is fully read before `handler`
 * runs; without a handler every request answers `404 {"detail":"Not Found"}`.
 */
export async function startLoopback(
  handler?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
): Promise<LoopbackServer> {
  let count = 0;
  let url: string | undefined;
  let method: string | undefined;
  let headers: IncomingMessage['headers'] | undefined;
  let lastBody: Buffer | undefined;
  const server = createServer((req, res) => {
    count += 1;
    url = req.url;
    method = req.method;
    headers = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks);
      if (handler) {
        handler(req, res, lastBody);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"detail":"Not Found"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests: () => count,
    lastUrl: () => url,
    lastMethod: () => method,
    lastHeaders: () => headers,
    lastBody: () => lastBody,
  };
}

/** A loopback port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Close every server started by {@link startLoopback}. */
export async function closeLoopbackServers(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
}
