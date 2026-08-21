import { describe, expect, it, vi } from 'vitest';

import {
  awaitPendingIngests,
  fetchExtractionResponse,
  resolvedAssetIdForIngest,
} from '@/lib/document/extract-source';

function jsonResponse(status: number): Response {
  return new Response(status >= 200 && status < 300 ? '{}' : '{"error":"nope"}', {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function byteResponse(): Response {
  return new Response('bytes', { status: 200 });
}

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

  it('falls back to the byte upload when the asset-id form returns a non-ok status', async () => {
    const submitAssetIdForm = vi.fn().mockResolvedValue(jsonResponse(500));
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
    const submitAssetIdForm = vi.fn().mockResolvedValue(jsonResponse(404));
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
    await expect(awaitPendingIngests(new Map())).resolves.toBeUndefined();
  });

  it('awaits all in-flight ingests, including rejected ones', async () => {
    const resolved = Promise.resolve('ast_a');
    const rejected = Promise.reject(new Error('put failed'));
    const map = new Map([
      ['a', resolved],
      ['b', rejected],
    ]);

    await expect(awaitPendingIngests(map)).resolves.toBeUndefined();
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
