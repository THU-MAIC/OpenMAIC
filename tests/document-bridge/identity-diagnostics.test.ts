import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_NAMESPACE_HEX_LENGTH,
  accountNamespace,
  sha256Hex,
} from '@/lib/document-bridge/identity';
import { durationBucket, reportBridgeDiagnostic } from '@/lib/document-bridge/diagnostics';

describe('DocumentStore bridge identity boundary', () => {
  it('uses a deterministic 128-bit hexadecimal account namespace', async () => {
    const namespace = await accountNamespace('11111111-2222-3333-4444-555555555555');

    expect(namespace).toHaveLength(ACCOUNT_NAMESPACE_HEX_LENGTH);
    expect(namespace).toMatch(/^[0-9a-f]{32}$/);
    expect(namespace).toBe((await sha256Hex('11111111-2222-3333-4444-555555555555')).slice(0, 32));
    expect(namespace).not.toBe(await accountNamespace('another-user'));
  });
});

describe('DocumentStore bridge diagnostics', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses bounded duration buckets', () => {
    expect(durationBucket(0)).toBe('lt_50ms');
    expect(durationBucket(50)).toBe('lt_250ms');
    expect(durationBucket(250)).toBe('lt_1s');
    expect(durationBucket(1_000)).toBe('gte_1s');
  });

  it('reports success without a course id and failure with a categorized course id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', fetchMock);

    reportBridgeDiagnostic({ outcome: 'success', durationMs: 20, bridgeVersion: 'b2.1' });
    reportBridgeDiagnostic({
      outcome: 'failure',
      durationMs: 300,
      bridgeVersion: 'b2.1',
      courseId: 'course-1',
      errorCode: 'validation',
    });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const successBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(successBody).toMatchObject({ outcome: 'success', durationBucket: 'lt_50ms' });
    expect(successBody).not.toHaveProperty('courseId');
    const failureBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(failureBody).toMatchObject({
      outcome: 'failure',
      durationBucket: 'lt_1s',
      courseId: 'course-1',
      errorCode: 'validation',
    });
  });
});
