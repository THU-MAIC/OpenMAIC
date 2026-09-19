import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The Qwen voice-clone adapter now issues requests through undici's fetch with
// a pinned dispatcher, so the vendor double stands in for undici.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

function deleteRequest(apiKey?: string): NextRequest {
  return new NextRequest('http://localhost/api/generate/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'qwen-tts',
      voiceId: 'exported-vendor-id',
      action: 'delete',
      ...(apiKey ? { ttsApiKey: apiKey } : {}),
    }),
  });
}

describe('Qwen voice deletion authorization', () => {
  beforeEach(() => fetchMock.mockReset());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('is local-only when the provider uses a server-managed key', async () => {
    vi.stubEnv('TTS_QWEN_API_KEY', 'server-managed-key');
    const fetchSpy = fetchMock;
    const { POST } = await import('@/app/api/generate/voice/route');

    const response = await POST(deleteRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      deleted: false,
      vendorDeleted: false,
      localOnly: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deletes provider-side only with the caller-owned key', async () => {
    vi.stubEnv('TTS_QWEN_API_KEY', '');
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { voice: 'exported-vendor-id' } })),
    );
    const { POST } = await import('@/app/api/generate/voice/route');

    const response = await POST(deleteRequest('caller-owned-key'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deleted: true,
      vendorDeleted: true,
      localOnly: false,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      input: { action: 'delete', voice: 'exported-vendor-id' },
    });
  });
});
