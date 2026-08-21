import { describe, expect, it, vi } from 'vitest';

import {
  awaitPendingIngests,
  fetchExtractionResponse,
  resolvedAssetIdForIngest,
  shouldRetryWithByteUpload,
} from '@/lib/document/extract-source';

function jsonResponse(status: number): Response {
  return new Response(status >= 200 && status < 300 ? '{}' : '{"error":"nope"}', {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A non-ok JSON error response carrying the route's errorCode, or an unparseable body when omitted. */
function errorResponse(status: number, errorCode?: string): Response {
  return new Response(
    errorCode === undefined
      ? 'not json'
      : JSON.stringify({ success: false, errorCode, error: 'x' }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function byteResponse(): Response {
  return new Response('bytes', { status: 200 });
}

describe('shouldRetryWithByteUpload', () => {
  it('never retries a successful response', async () => {
    await expect(shouldRetryWithByteUpload(jsonResponse(200))).resolves.toBe(false);
  });

  it('does not retry a PARSE_FAILED 422 (the extractor already ran)', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(422, 'PARSE_FAILED'))).resolves.toBe(
      false,
    );
  });

  it('does not retry a PARSE_FAILED 500 (the extractor already ran)', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(500, 'PARSE_FAILED'))).resolves.toBe(
      false,
    );
  });

  it('retries a pre-extraction INTERNAL_ERROR 500', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(500, 'INTERNAL_ERROR'))).resolves.toBe(
      true,
    );
  });

  it('retries a 404 ASSET_NOT_FOUND', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(404, 'ASSET_NOT_FOUND'))).resolves.toBe(
      true,
    );
  });

  it('does not retry a 403 INVALID_URL (the SSRF guard runs the same check on the byte form)', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(403, 'INVALID_URL'))).resolves.toBe(false);
  });

  it('does not retry a 413 (the byte form enforces the same 50 MB cap on the same bytes)', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(413, 'INVALID_REQUEST'))).resolves.toBe(
      false,
    );
  });

  it('retries a 401 UNAUTHENTICATED', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(401, 'UNAUTHENTICATED'))).resolves.toBe(
      true,
    );
  });

  it('retries a 400 INVALID_REQUEST (it may be JSON-form-specific)', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(400, 'INVALID_REQUEST'))).resolves.toBe(
      true,
    );
  });

  it('retries a response whose body cannot be parsed', async () => {
    await expect(shouldRetryWithByteUpload(errorResponse(500))).resolves.toBe(true);
  });
});

describe('fetchExtractionResponse', () => {
  it('uses the asset-id form when the pool is server-backed and it succeeds', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(jsonResponse(200));
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(200);
    expect(submitAssetIdForm).toHaveBeenCalledTimes(1);
    expect(submitByteForm).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('does not retry with bytes when the asset-id form returns PARSE_FAILED 500 (the extractor already ran)', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(errorResponse(500, 'PARSE_FAILED'));
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(500);
    expect(submitAssetIdForm).toHaveBeenCalledTimes(1);
    expect(submitByteForm).not.toHaveBeenCalled();
    expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('PARSE_FAILED'));
  });

  it('does not retry with bytes when the asset-id form returns PARSE_FAILED 422', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(errorResponse(422, 'PARSE_FAILED'));
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(422);
    expect(submitAssetIdForm).toHaveBeenCalledTimes(1);
    expect(submitByteForm).not.toHaveBeenCalled();
  });

  it('does not retry with bytes when the asset-id form returns a 403 INVALID_URL (SSRF on the caller baseUrl)', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(errorResponse(403, 'INVALID_URL'));
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(403);
    expect(submitAssetIdForm).toHaveBeenCalledTimes(1);
    expect(submitByteForm).not.toHaveBeenCalled();
  });

  it('does not retry with bytes when the asset-id form returns a 413 (byte form repeats the same size check)', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(errorResponse(413, 'INVALID_REQUEST'));
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(413);
    expect(submitAssetIdForm).toHaveBeenCalledTimes(1);
    expect(submitByteForm).not.toHaveBeenCalled();
  });

  it('falls back to the byte upload on a pre-extraction INTERNAL_ERROR 500', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(errorResponse(500, 'INTERNAL_ERROR'));
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(200);
    expect(submitAssetIdForm).toHaveBeenCalledTimes(1);
    expect(submitByteForm).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      expect.stringContaining('Asset-id extraction returned 500'),
    );
  });

  it('falls back to the byte upload when the response body cannot be parsed', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(errorResponse(503));
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(200);
    expect(submitAssetIdForm).toHaveBeenCalledTimes(1);
    expect(submitByteForm).toHaveBeenCalledTimes(1);
  });

  it('falls back to the byte upload when the asset-id form throws a network error', async () => {
    const submitAssetIdForm = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(200);
    expect(submitAssetIdForm).toHaveBeenCalledTimes(1);
    expect(submitByteForm).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      expect.stringContaining('falling back to byte upload'),
      expect.any(TypeError),
    );
  });

  it('surfaces the byte-form failure when both forms fail', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(errorResponse(404, 'ASSET_NOT_FOUND'));
    const byteFailure = new Error('course material could not be loaded');
    const submitByteForm = vi.fn().mockRejectedValue(byteFailure);
    const logWarning = vi.fn();

    await expect(
      fetchExtractionResponse({
        serverBacked: true,
        hasAssetId: true,
        fetchers: { submitAssetIdForm, submitByteForm },
        logWarning,
      }),
    ).rejects.toBe(byteFailure);
    expect(logWarning).toHaveBeenCalledTimes(1);
  });

  it('surfaces the byte-form failure when the asset-id form is skipped', async () => {
    const submitAssetIdForm = vi.fn();
    const byteFailure = new Error('no bytes exist');
    const submitByteForm = vi.fn().mockRejectedValue(byteFailure);
    const logWarning = vi.fn();

    await expect(
      fetchExtractionResponse({
        serverBacked: true,
        hasAssetId: false,
        fetchers: { submitAssetIdForm, submitByteForm },
        logWarning,
      }),
    ).rejects.toBe(byteFailure);
    expect(submitAssetIdForm).not.toHaveBeenCalled();
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('goes straight to the byte upload for a browser-backed pool', async () => {
    const submitAssetIdForm = vi.fn();
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: false,
      hasAssetId: true,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(200);
    expect(submitAssetIdForm).not.toHaveBeenCalled();
    expect(submitByteForm).toHaveBeenCalledTimes(1);
    expect(logWarning).not.toHaveBeenCalled();
  });

  it('goes straight to the byte upload when the source has no asset id', async () => {
    const submitAssetIdForm = vi.fn();
    const submitByteForm = vi.fn().mockResolvedValue(byteResponse());
    const logWarning = vi.fn();

    const response = await fetchExtractionResponse({
      serverBacked: true,
      hasAssetId: false,
      fetchers: { submitAssetIdForm, submitByteForm },
      logWarning,
    });

    expect(response.status).toBe(200);
    expect(submitAssetIdForm).not.toHaveBeenCalled();
    expect(submitByteForm).toHaveBeenCalledTimes(1);
  });
});

describe('awaitPendingIngests', () => {
  it('resolves immediately for an empty map', async () => {
    const onUnsettled = vi.fn();
    const unsettled = await awaitPendingIngests(new Map(), { timeoutMs: 1000, onUnsettled });

    expect(unsettled.size).toBe(0);
    expect(onUnsettled).not.toHaveBeenCalled();
  });

  it('awaits all in-flight ingests, including rejected ones, settling before the timeout', async () => {
    const onUnsettled = vi.fn();
    const resolved = Promise.resolve('ast_a');
    const rejected = Promise.reject(new Error('put failed'));
    const map = new Map([
      ['a', resolved],
      ['b', rejected],
    ]);

    const unsettled = await awaitPendingIngests(map, { timeoutMs: 1000, onUnsettled });

    expect(unsettled.size).toBe(0);
    expect(onUnsettled).not.toHaveBeenCalled();
  });

  it('times out and returns the ids of unsettled ingests, invoking the release callback for each', async () => {
    const onUnsettled = vi.fn();
    const stalled = new Promise<string>(() => {
      /* never settles */
    });
    const map = new Map([['a', stalled]]);

    const unsettled = await awaitPendingIngests(map, { timeoutMs: 10, onUnsettled });

    expect(unsettled.has('a')).toBe(true);
    expect(onUnsettled).toHaveBeenCalledTimes(1);
    expect(onUnsettled).toHaveBeenCalledWith('a', map.get('a'));
  });

  it('invokes the release callback when a timed-out ingest resolves late', async () => {
    let resolveLate!: (assetId: string) => void;
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const map = new Map([['a', late]]);
    const released: string[] = [];

    const unsettled = await awaitPendingIngests(map, {
      timeoutMs: 10,
      onUnsettled: (_id, ingest) => {
        void ingest.then(
          (assetId) => released.push(assetId),
          () => undefined,
        );
      },
    });

    expect(unsettled.has('a')).toBe(true);

    resolveLate('ast_late');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(released).toEqual(['ast_late']);
  });
});

describe('resolvedAssetIdForIngest', () => {
  it('returns undefined for an id with no pending ingest', async () => {
    await expect(resolvedAssetIdForIngest(new Map(), 'missing')).resolves.toBeUndefined();
  });

  it('returns the settled asset id for a resolved ingest', async () => {
    const map = new Map([['a', Promise.resolve('ast_a')]]);
    await expect(resolvedAssetIdForIngest(map, 'a')).resolves.toBe('ast_a');
  });

  it('returns undefined for a rejected ingest', async () => {
    const map = new Map([['a', Promise.reject(new Error('put failed'))]]);
    await expect(resolvedAssetIdForIngest(map, 'a')).resolves.toBeUndefined();
  });
});
