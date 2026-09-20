/**
 * The server half of the KV HTTP contract: `/kv/entries/<key>` and `/kv/keys`,
 * partitioned by the principal the deployment authenticates.
 *
 * The contract carries **no scope on the wire** — it is account-scoped and the
 * principal is derived server-side. Every channel a scope could hide in (a path
 * segment, a query parameter, a scope-spelling header, a body field, and a body
 * on a bodyless method) is refused loudly rather than ignored: a request that
 * tried to name a scope and was silently served would be indistinguishable, to
 * the caller, from one the server understood. `test/kv-conformance-server.ts`
 * is the same contract standing in for this module on the client's side of the
 * suite; the two are held together by `test/kv-http-handler.test.ts`, which runs
 * the shared contract through this handler.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { assertJsonValue } from '../runtime/json-value.js';
import type { PgKVStore } from '../kv/pg.js';

/** What the deployment's authenticator resolves a request to. */
export interface KVHttpPrincipal {
  /** The partition key. Server-derived — never read from the request body. */
  owner: string;
}

export interface KVHttpHandlerOptions {
  authenticate(
    req: IncomingMessage,
  ): Promise<KVHttpPrincipal | undefined> | KVHttpPrincipal | undefined;
  /** Request body ceiling; a larger body is refused with 413. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Reads must not be cached: a stale account value is a wrong answer, not a fast one. */
const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * Every header spelling that would convey a scope. Enumerated rather than
 * matched on a prefix: "just `x-scope`" leaves `scope`, `kv-scope` and the
 * `x-`-prefixed variants open, and a client reaches for any of them as naturally.
 */
const PROHIBITED_SCOPE_HEADERS = ['scope', 'x-scope', 'kv-scope', 'x-kv-scope'] as const;

const SCOPE_REFUSAL =
  'device scope crossed the network boundary: this contract is account-scoped and the ' +
  'principal is derived server-side';

class KVHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KVHttpError';
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof KVHttpError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  // Never echo an internal failure's message: an internal detail on the wire is
  // a leak, and the contract's INTERNAL_ERROR row promises we do not do it.
  sendJson(res, 500, {
    error: { code: 'INTERNAL_ERROR', message: '@openmaic/storage: internal server error' },
  });
}

async function readBytes(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new KVHttpError(
        413,
        'PAYLOAD_TOO_LARGE',
        `@openmaic/storage: request body exceeds ${maxBodyBytes} bytes`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Split the RAW request target, not `url.pathname`. The WHATWG parser resolves
 * dot segments before anything here can look and treats `%2e` as one, so a
 * validator reading the parsed path would be inspecting a request nobody sent.
 */
function pathParts(req: IncomingMessage): { parts: string[]; url: URL } {
  const target = req.url ?? '/';
  const url = new URL(target, 'http://storage.invalid');
  const rawPath = target.split(/[?#]/, 1)[0] ?? '/';
  const rawParts = rawPath.split('/');
  if (rawParts[0] === '') rawParts.shift();
  const parts: string[] = [];
  for (const part of rawParts) {
    try {
      parts.push(decodeURIComponent(part));
    } catch {
      throw new KVHttpError(
        400,
        'VALIDATION_FAILED',
        '@openmaic/storage: request path is not valid percent-encoded UTF-8',
      );
    }
  }
  return { parts, url };
}

function assertNoScopeChannel(req: IncomingMessage, url: URL, parts: string[]): void {
  // A scope path segment sits where `entries` or `keys` belongs. A KEY named
  // `device` is fine — that lands at parts[2], after `entries`.
  if (parts[1] === 'device' || parts[1] === 'account') {
    throw new KVHttpError(400, 'VALIDATION_FAILED', `@openmaic/storage: ${SCOPE_REFUSAL}`);
  }
  if (url.searchParams.has('scope')) {
    throw new KVHttpError(400, 'VALIDATION_FAILED', `@openmaic/storage: ${SCOPE_REFUSAL}`);
  }
  for (const header of PROHIBITED_SCOPE_HEADERS) {
    if (req.headers[header] !== undefined) {
      throw new KVHttpError(
        400,
        'VALIDATION_FAILED',
        `@openmaic/storage: ${SCOPE_REFUSAL} (header ${header})`,
      );
    }
  }
}

/**
 * A body is a scope channel too, and GET/DELETE have no legitimate use for one.
 * Refused outright rather than parsed: a GET that merely ignored its body would
 * let `GET /kv/keys` carrying `{"scope":"device"}` succeed, which is the
 * every-channel-is-closed guarantee failing silently.
 */
async function assertNoRequestBody(req: IncomingMessage, maxBodyBytes: number): Promise<void> {
  const body = await readBytes(req, maxBodyBytes);
  if (body.length > 0) {
    throw new KVHttpError(
      400,
      'VALIDATION_FAILED',
      `@openmaic/storage: ${req.method ?? 'GET'} must not carry a request body — ${SCOPE_REFUSAL}`,
    );
  }
}

async function readJsonObject(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const raw = await readBytes(req, maxBodyBytes);
  if (raw.length === 0) {
    throw new KVHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: request body must be a JSON object',
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    throw new KVHttpError(
      400,
      'VALIDATION_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new KVHttpError(
      400,
      'VALIDATION_FAILED',
      '@openmaic/storage: request body must be a JSON object',
    );
  }
  return body as Record<string, unknown>;
}

export function createKVHttpHandler(
  store: PgKVStore,
  options: KVHttpHandlerOptions,
): RequestListener {
  if (typeof options?.authenticate !== 'function') {
    throw new Error('@openmaic/storage: createKVHttpHandler requires authenticate');
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return (req, res) => {
    void (async () => {
      try {
        const { parts, url } = pathParts(req);
        const method = req.method ?? 'GET';
        assertNoScopeChannel(req, url, parts);
        if (method === 'GET' || method === 'DELETE') {
          await assertNoRequestBody(req, maxBodyBytes);
        }

        const principal = await options.authenticate(req);
        if (principal === undefined) {
          throw new KVHttpError(
            401,
            'UNAUTHENTICATED',
            '@openmaic/storage: request is not authenticated',
          );
        }
        const { owner } = principal;

        if (method === 'GET' && parts.length === 2 && parts[1] === 'keys') {
          const prefix = url.searchParams.get('prefix') ?? '';
          sendJson(res, 200, await store.keys(owner, prefix), NO_STORE);
          return;
        }

        if (parts.length === 3 && parts[1] === 'entries') {
          // The decoded key is opaque: any string is a legitimate key and
          // traverses nothing, because it is a column value, never a path.
          const key = parts[2]!;
          if (method === 'GET') {
            const value = await store.get<unknown>(owner, key);
            if (value === null) {
              throw new KVHttpError(
                404,
                'KEY_NOT_FOUND',
                `@openmaic/storage: no kv entry ${JSON.stringify(key)}`,
              );
            }
            sendJson(res, 200, { value }, NO_STORE);
            return;
          }
          if (method === 'PUT') {
            const body = await readJsonObject(req, maxBodyBytes);
            if (!('value' in body)) {
              throw new KVHttpError(
                400,
                'VALIDATION_FAILED',
                '@openmaic/storage: kv write body must carry "value"',
              );
            }
            if ('scope' in body) {
              throw new KVHttpError(
                400,
                'VALIDATION_FAILED',
                `@openmaic/storage: kv write body must not carry a scope — ${SCOPE_REFUSAL}`,
              );
            }
            try {
              assertJsonValue(body.value, `kv value for key ${JSON.stringify(key)}`);
            } catch (error) {
              throw new KVHttpError(
                400,
                'VALIDATION_FAILED',
                error instanceof Error ? error.message : String(error),
              );
            }
            await store.set(owner, key, body.value);
            sendNoContent(res);
            return;
          }
          if (method === 'DELETE') {
            await store.remove(owner, key);
            sendNoContent(res);
            return;
          }
        }

        throw new KVHttpError(404, 'ROUTE_NOT_FOUND', '@openmaic/storage: route not found');
      } catch (error) {
        sendError(res, error);
      }
    })();
  };
}
