import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpDocumentStore } from '../src/document/http.js';
import { HttpRuntimeStore } from '../src/runtime/http.js';

/**
 * Browsers require fetch to be invoked with `this === globalThis`; a stored
 * reference called as `this.fetchImpl(...)` throws "Illegal invocation".
 * Node's undici does not enforce this, so only an explicit this-check can
 * guard the regression in a node test run.
 */
function strictFetch(): typeof globalThis.fetch {
  const marker = globalThis;
  return vi.fn(function (this: unknown) {
    if (this !== marker && this !== undefined) {
      throw new TypeError('Illegal invocation');
    }
    // `bind(globalThis)` makes `this` the global; an unbound store-field call
    // would surface the store instance here instead.
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
}

describe('HTTP store fetch binding', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('HttpDocumentStore invokes the default global fetch without an instance receiver', async () => {
    const spy = strictFetch();
    globalThis.fetch = new Proxy(spy, {
      apply(target, thisArg, args) {
        if (thisArg !== globalThis && thisArg !== undefined) {
          throw new TypeError('Illegal invocation');
        }
        return Reflect.apply(target, thisArg, args as Parameters<typeof fetch>);
      },
    }) as typeof globalThis.fetch;
    const store = new HttpDocumentStore({ baseUrl: 'http://example.test' });

    await expect(store.listDocuments()).resolves.toEqual([]);
  });

  it('HttpRuntimeStore invokes the default global fetch without an instance receiver', async () => {
    const spy = strictFetch();
    globalThis.fetch = new Proxy(spy, {
      apply(target, thisArg, args) {
        if (thisArg !== globalThis && thisArg !== undefined) {
          throw new TypeError('Illegal invocation');
        }
        return Reflect.apply(target, thisArg, args as Parameters<typeof fetch>);
      },
    }) as typeof globalThis.fetch;
    const store = new HttpRuntimeStore({ baseUrl: 'http://example.test' });

    await expect(store.listSessions('stage-1', 'learner-1')).resolves.toEqual([]);
  });
});

describe('HTTP store fetch validation order', () => {
  it('reports the documented error for a non-function fetch option instead of a native bind TypeError', () => {
    expect(() => new HttpDocumentStore({ baseUrl: 'http://x', fetch: {} as never })).toThrowError(
      /requires a fetch implementation/,
    );
    expect(() => new HttpRuntimeStore({ baseUrl: 'http://x', fetch: {} as never })).toThrowError(
      /requires a fetch implementation/,
    );
  });
});
