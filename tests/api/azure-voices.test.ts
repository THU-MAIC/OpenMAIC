/**
 * `/api/azure-voices` runs through the strict provider transport.
 *
 * Drives the real route, the real SSRF guard and the real pinned transport
 * against loopback HTTP servers. Only `node:dns` (to split the URL-layer and
 * connect-time answers for rebinding) and the global `fetch` (a spy that must
 * never be called) are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/azure-voices/route';
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

const FETCH_FAILED = {
  success: false,
  errorCode: 'INTERNAL_ERROR',
  error: 'Failed to fetch voices from Azure',
};

async function postAzureVoices(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/azure-voices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('POST /api/azure-voices', () => {
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

    it('returns the voice list', async () => {
      const azure = await startLoopback((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ ShortName: 'en-US-JennyNeural' }]));
      });

      const res = await postAzureVoices({ apiKey: 'k', baseUrl: azure.origin });

      expect(res).toEqual({
        status: 200,
        json: { success: true, voices: [{ ShortName: 'en-US-JennyNeural' }] },
      });
      expect(azure.lastUrl()).toBe('/cognitiveservices/voices/list');
      expect(azure.lastHeaders()!['ocp-apim-subscription-key']).toBe('k');
    });

    it.each([401, 403])('answers %i with a fixed message and no body', async (status) => {
      const azure = await startLoopback((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end('internal-secret-body');
      });

      const res = await postAzureVoices({ apiKey: 'bad', baseUrl: azure.origin });

      expect(res).toEqual({
        status: 502,
        json: {
          success: false,
          errorCode: 'UPSTREAM_ERROR',
          error: 'Authentication failed, please check the API Key',
        },
      });
    });

    it('does not mirror the upstream status or body, and never returns non-list JSON', async () => {
      const notFound = await startLoopback((_req, res) => {
        res.writeHead(418, { 'Content-Type': 'text/plain' });
        res.end('internal-secret-body');
      });
      const object = await startLoopback((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"secret":"internal-secret-body"}');
      });

      const a = await postAzureVoices({ apiKey: 'k', baseUrl: notFound.origin });
      const b = await postAzureVoices({ apiKey: 'k', baseUrl: object.origin });

      for (const res of [a, b]) {
        expect(res).toEqual({
          status: 502,
          json: { ...FETCH_FAILED, errorCode: 'UPSTREAM_ERROR' },
        });
      }
    });

    it('refuses a redirect and never follows it', async () => {
      const target = await startLoopback();
      const origin = await startLoopback((_req, res) => {
        res.writeHead(302, { Location: `${target.origin}/sink` });
        res.end();
      });

      const res = await postAzureVoices({ apiKey: 'k', baseUrl: origin.origin });

      expect(res).toEqual({ status: 500, json: FETCH_FAILED });
      expect(origin.requests()).toBe(1);
      expect(target.requests()).toBe(0);
    });

    it('answers a refused connection with the same fixed message', async () => {
      const res = await postAzureVoices({
        apiKey: 'k',
        baseUrl: `http://127.0.0.1:${await closedPort()}`,
      });
      expect(res).toEqual({ status: 500, json: FETCH_FAILED });
    });
  });

  it('refuses a host that rebinds to loopback between validation and connect', async () => {
    const trap = await startLoopback();

    const res = await postAzureVoices({ apiKey: 'k', baseUrl: `http://rebind.test:${trap.port}` });

    expect(mocks.promisesLookup).toHaveBeenCalled();
    expect(mocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
    expect(res).toEqual({ status: 500, json: FETCH_FAILED });
    expect(trap.requests()).toBe(0);
  });
});
