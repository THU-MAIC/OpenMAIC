/**
 * Client-supplied AliDocMind endpoints are limited to official DocMind hosts.
 *
 * The DocMind SDK builds its own HTTPS agent and cannot be pinned, so the
 * routes refuse any other endpoint before an SDK call. Drives the real
 * verify-pdf-provider, parse-pdf and extract-document routes; stubbed are
 * `@/lib/server/provider-config` (partially: managed or not) and the DocMind
 * client module (so no SDK request is made and the endpoint it would receive
 * is observable).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST as extractDocumentPOST } from '@/app/api/extract-document/route';
import { POST as parsePdfPOST } from '@/app/api/parse-pdf/route';
import { POST as verifyPdfProviderPOST } from '@/app/api/verify-pdf-provider/route';
import { resolveSafeClientAliDocMindEndpoint } from '@/lib/server/alidocmind-endpoint';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolveManagedAliDocMindCredentials: vi.fn(),
  verifyAliDocMindCredentials: vi.fn(),
  parseWithAliDocMindClient: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials: mocks.resolveManagedAliDocMindCredentials,
}));

vi.mock('@/lib/pdf/alidocmind-client', () => ({
  verifyAliDocMindCredentials: mocks.verifyAliDocMindCredentials,
  parseWithAliDocMindClient: mocks.parseWithAliDocMindClient,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const NOT_ALLOWED = {
  success: false,
  errorCode: 'INVALID_URL',
  error: 'Only official AliDocMind endpoints (docmind-api.<region>.aliyuncs.com) are supported',
};

const REJECTED_ENDPOINTS = [
  'http://127.0.0.1:8080',
  'internal.example.test',
  'https://docmind-api.oss-cn-hangzhou.aliyuncs.com',
  'https://docmind-api.cn-hangzhou.aliyuncs.com.example.test',
  'http://docmind-api.cn-hangzhou.aliyuncs.com',
  'https://docmind-api.cn-hangzhou.aliyuncs.com:8443',
  'https://docmind-api.cn-hangzhou.aliyuncs.com/proxy',
  'https://user@docmind-api.cn-hangzhou.aliyuncs.com',
];

describe('resolveSafeClientAliDocMindEndpoint', () => {
  it.each([
    ['docmind-api.cn-hangzhou.aliyuncs.com', 'docmind-api.cn-hangzhou.aliyuncs.com'],
    ['https://docmind-api.cn-hangzhou.aliyuncs.com/', 'docmind-api.cn-hangzhou.aliyuncs.com'],
    [' DOCMIND-API.ap-southeast-1.aliyuncs.com ', 'docmind-api.ap-southeast-1.aliyuncs.com'],
  ])('accepts %s', (input, host) => {
    expect(resolveSafeClientAliDocMindEndpoint(input)).toBe(host);
  });

  it.each(REJECTED_ENDPOINTS)('rejects %s', (input) => {
    expect(resolveSafeClientAliDocMindEndpoint(input)).toBeNull();
  });
});

function jsonRequest(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function multipartRequest(path: string, fileName: string, fields: Record<string, string>) {
  const form = new FormData();
  form.append(path.includes('parse-pdf') ? 'pdf' : 'file', new File([new Uint8Array(8)], fileName));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: form,
  }) as unknown as NextRequest;
}

async function read(res: Response) {
  return { status: res.status, json: await res.json() };
}

describe('AliDocMind endpoint allowlist in the routes', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.verifyAliDocMindCredentials.mockResolvedValue({ ok: true });
    mocks.parseWithAliDocMindClient.mockRejectedValue(new Error('not reached in these tests'));
  });

  it.each(REJECTED_ENDPOINTS)(
    'verify-pdf-provider refuses %s before any SDK call',
    async (endpoint) => {
      const res = await read(
        await verifyPdfProviderPOST(
          jsonRequest('/api/verify-pdf-provider', {
            providerId: 'alidocmind',
            accessKeyId: 'ak',
            accessKeySecret: 'sk',
            baseUrl: endpoint,
          }),
        ),
      );

      expect(res).toEqual({ status: 403, json: NOT_ALLOWED });
      expect(mocks.verifyAliDocMindCredentials).not.toHaveBeenCalled();
    },
  );

  it('verify-pdf-provider passes an official endpoint to the SDK as a bare host', async () => {
    const res = await read(
      await verifyPdfProviderPOST(
        jsonRequest('/api/verify-pdf-provider', {
          providerId: 'alidocmind',
          accessKeyId: 'ak',
          accessKeySecret: 'sk',
          baseUrl: 'https://docmind-api.cn-hangzhou.aliyuncs.com',
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.verifyAliDocMindCredentials).toHaveBeenCalledWith({
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      endpoint: 'docmind-api.cn-hangzhou.aliyuncs.com',
    });
  });

  it('verify-pdf-provider leaves a server-managed endpoint unrestricted', async () => {
    mocks.isServerConfiguredProvider.mockReturnValue(true);
    mocks.resolveManagedAliDocMindCredentials.mockReturnValue({
      accessKeyId: 'server-ak',
      accessKeySecret: 'server-sk',
      baseUrl: 'docmind-gateway.internal.test',
    });

    const res = await read(
      await verifyPdfProviderPOST(
        jsonRequest('/api/verify-pdf-provider', {
          providerId: 'alidocmind',
          baseUrl: 'http://127.0.0.1:8080',
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.verifyAliDocMindCredentials).toHaveBeenCalledWith({
      accessKeyId: 'server-ak',
      accessKeySecret: 'server-sk',
      endpoint: 'docmind-gateway.internal.test',
    });
  });

  it('parse-pdf refuses a custom AliDocMind endpoint', async () => {
    const res = await read(
      await parsePdfPOST(
        multipartRequest('/api/parse-pdf', 'doc.pdf', {
          providerId: 'alidocmind',
          baseUrl: 'internal.example.test',
        }),
      ),
    );

    expect(res).toEqual({ status: 403, json: NOT_ALLOWED });
    expect(mocks.parseWithAliDocMindClient).not.toHaveBeenCalled();
  });

  it.each([
    ['document', 'doc.pdf'],
    ['media', 'talk.mp3'],
  ])('extract-document refuses a custom AliDocMind endpoint (%s)', async (_kind, fileName) => {
    const res = await read(
      await extractDocumentPOST(
        multipartRequest('/api/extract-document', fileName, {
          providerId: 'alidocmind',
          accessKeyId: 'ak',
          accessKeySecret: 'sk',
          baseUrl: 'http://127.0.0.1:8080',
        }),
      ),
    );

    expect(res).toEqual({ status: 403, json: NOT_ALLOWED });
    expect(mocks.parseWithAliDocMindClient).not.toHaveBeenCalled();
  });
});
