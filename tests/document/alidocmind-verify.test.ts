import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the Aliyun SDK so we can drive verifyAliDocMindCredentials deterministically.
const queryDocParserStatus = vi.fn();

vi.mock('@alicloud/docmind-api20220711', () => {
  class Client {
    queryDocParserStatus = queryDocParserStatus;
  }
  return {
    default: Client,
    QueryDocParserStatusRequest: class {
      constructor(public args: unknown) {}
    },
  };
});
vi.mock('@alicloud/openapi-client', () => ({
  Config: class {
    constructor(public args: unknown) {}
  },
}));
vi.mock('@alicloud/tea-util', () => ({
  RuntimeOptions: class {
    constructor(public args: unknown) {}
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { verifyAliDocMindCredentials } from '@/lib/pdf/alidocmind-client';

const CREDS = { accessKeyId: 'ak', accessKeySecret: 'sk' };

describe('verifyAliDocMindCredentials', () => {
  afterEach(() => {
    queryDocParserStatus.mockReset();
  });

  it('accepts a no-throw job-not-found probe response (creds + DocMind OK)', async () => {
    queryDocParserStatus.mockResolvedValue({
      body: { code: 'BizIdNotExistOrResultExpired', message: 'The bizId does not exist' },
    });
    await expect(verifyAliDocMindCredentials(CREDS)).resolves.toEqual({ ok: true });
  });

  it('rejects a no-throw NoPermission body (OSS-only key without DocMind access)', async () => {
    // Regression: the previous implementation returned ok:true for ANY
    // non-throwing response, so an OSS-only key showed "connection successful"
    // and then failed at real extraction with NoPermission.
    queryDocParserStatus.mockResolvedValue({
      body: { code: 'NoPermission', message: 'You are not authorized to operate DocMind.' },
    });
    const result = await verifyAliDocMindCredentials(CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/NoPermission/);
  });

  it('accepts a success body (code 200)', async () => {
    queryDocParserStatus.mockResolvedValue({ body: { code: '200' } });
    await expect(verifyAliDocMindCredentials(CREDS)).resolves.toEqual({ ok: true });
  });

  it('rejects an empty/absent response body code (malformed or custom endpoint)', async () => {
    // A blank code is NOT a positive signal — a working key always returns the
    // job-not-found business code for the bogus probe id.
    queryDocParserStatus.mockResolvedValue({ body: {} });
    const empty = await verifyAliDocMindCredentials(CREDS);
    expect(empty.ok).toBe(false);

    queryDocParserStatus.mockResolvedValue({ body: undefined });
    const noBody = await verifyAliDocMindCredentials(CREDS);
    expect(noBody.ok).toBe(false);
  });

  it('rejects a thrown auth error (invalid AK/SK)', async () => {
    queryDocParserStatus.mockRejectedValue(
      Object.assign(new Error('Specified access key is not found'), {
        code: 'InvalidAccessKeyId.NotFound',
      }),
    );
    const result = await verifyAliDocMindCredentials(CREDS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/InvalidAccessKeyId/);
  });

  it('accepts a thrown job-not-found business error', async () => {
    queryDocParserStatus.mockRejectedValue(new Error('The bizId does not exist or is expired'));
    await expect(verifyAliDocMindCredentials(CREDS)).resolves.toEqual({ ok: true });
  });

  it('rejects an unreachable endpoint / unclassifiable throw', async () => {
    queryDocParserStatus.mockRejectedValue(new Error('getaddrinfo ENOTFOUND bad.host'));
    const result = await verifyAliDocMindCredentials(CREDS);
    expect(result.ok).toBe(false);
  });
});
