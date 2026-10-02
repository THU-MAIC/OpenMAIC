/**
 * `/api/provider/probe-models` runs through the strict provider transport.
 *
 * Drives the real route, the real SSRF guard and the real pinned transport
 * against loopback HTTP servers. Only `node:dns` (to split the URL-layer and
 * connect-time answers for rebinding) and the global `fetch` (a spy that must
 * never be called) are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/provider/probe-models/route';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closedPort,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const CONNECTION_FAILED = {
  status: 502,
  json: {
    success: false,
    errorCode: 'UPSTREAM_ERROR',
    error: 'Cannot connect to the provider, please check the Base URL',
  },
};

async function postProbeModels(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/provider/probe-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

/** A loopback server that answers every request with one fixed response. */
function answering(status: number, body: string, headers: Record<string, string> = {}) {
  return startLoopback((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body);
  });
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('POST /api/provider/probe-models', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    expect(globalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    await closeLoopbackServers();
  });

  describe('with the operator local-network opt-in', () => {
    beforeEach(() => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
    });

    it('preserves successful model filtering and response metadata', async () => {
      const provider = await answering(
        200,
        JSON.stringify({
          data: [
            { id: 'chat-model', owned_by: 'provider' },
            { id: 'text-embedding-3-small', owned_by: 'provider' },
          ],
        }),
      );

      const res = await postProbeModels({ baseUrl: provider.origin, apiKey: 'test-key' });

      expect(res).toEqual({
        status: 200,
        json: {
          success: true,
          models: [{ id: 'chat-model', ownedBy: 'provider' }],
          total: 2,
          filtered: 1,
        },
      });
      expect(provider.lastUrl()).toBe('/v1/models');
      expect(provider.lastHeaders()!.authorization).toBe('Bearer test-key');
    });

    it('refuses a redirect with the redirect contract and never follows it', async () => {
      const target = await answering(200, '{"data":[{"id":"sink"}]}');
      const origin = await answering(302, 'redirect response body', {
        Location: `${target.origin}/v1/models`,
      });

      const res = await postProbeModels({ baseUrl: origin.origin, apiKey: 'test-key' });

      expect(res).toEqual({
        status: 403,
        json: {
          success: false,
          errorCode: 'REDIRECT_NOT_ALLOWED',
          error: 'Redirects are not allowed',
        },
      });
      expect(origin.requests()).toBe(1);
      expect(target.requests()).toBe(0);
    });

    it.each([401, 403])('preserves the API-key error contract for upstream %i', async (status) => {
      const provider = await answering(status, 'internal-secret-body');

      const res = await postProbeModels({ baseUrl: provider.origin, apiKey: 'bad-key' });

      expect(res).toEqual({
        status: 401,
        json: {
          success: false,
          errorCode: 'INVALID_REQUEST',
          error: 'API key is invalid or expired',
        },
      });
    });

    it('preserves the manual-entry response when no model endpoint exists', async () => {
      const provider = await answering(404, '{"detail":"Not Found"}');

      const res = await postProbeModels({ baseUrl: provider.origin, apiKey: 'test-key' });

      expect(res).toEqual({
        status: 404,
        json: {
          success: false,
          errorCode: 'INVALID_REQUEST',
          error: 'This provider does not expose a model list',
        },
      });
    });

    it('reports only the status class of other errors, never the body', async () => {
      const provider = await answering(500, 'internal-secret-body');

      const res = await postProbeModels({ baseUrl: provider.origin, apiKey: 'test-key' });

      expect(res).toEqual({
        status: 502,
        json: {
          success: false,
          errorCode: 'UPSTREAM_ERROR',
          error: 'The provider rejected the model list request (HTTP 5xx)',
        },
      });
    });

    it('does not surface a JSON parser snippet for a non-JSON success body', async () => {
      const provider = await answering(200, '<html>internal-secret-page</html>', {
        'Content-Type': 'text/html',
      });

      const res = await postProbeModels({ baseUrl: provider.origin, apiKey: 'test-key' });

      expect(res).toEqual({
        status: 502,
        json: {
          success: false,
          errorCode: 'UPSTREAM_ERROR',
          error: 'The provider returned an invalid model list',
        },
      });
    });

    it('answers a refused connection with the fixed message', async () => {
      const res = await postProbeModels({ baseUrl: `http://127.0.0.1:${await closedPort()}` });
      expect(res).toEqual(CONNECTION_FAILED);
    });
  });

  it.each(['baseUrl', 'modelsUrl'])(
    'refuses a %s host that rebinds to loopback between validation and connect',
    async (field) => {
      const trap = await answering(200, '{"data":[{"id":"internal"}]}');
      const rebinding = `http://rebind.test:${trap.port}`;

      const res = await postProbeModels(
        field === 'baseUrl'
          ? { baseUrl: rebinding, apiKey: 'k' }
          : { baseUrl: 'https://api.example.test', modelsUrl: `${rebinding}/models`, apiKey: 'k' },
      );

      expect(mocks.callbackLookup).toHaveBeenCalledWith(
        'rebind.test',
        expect.anything(),
        expect.any(Function),
      );
      expect(res).toEqual(CONNECTION_FAILED);
      expect(trap.requests()).toBe(0);
    },
  );
});
