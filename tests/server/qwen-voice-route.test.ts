import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '@/app/api/generate/voice/route';
import { clearQwenVoiceRegistrationMemoForTests } from '@/lib/audio/qwen-voice-clone-registration';

function request(referenceAudioBase64 = 'unused-when-voice-exists'): NextRequest {
  return new NextRequest('http://localhost/api/generate/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'qwen-tts',
      voiceId: 'voice-1',
      referenceAudioBase64,
      refText: 'Reference transcript.',
      ttsApiKey: 'client-key',
      ttsModelId: 'qwen3-tts-vc-test',
    }),
  });
}

function validReferenceAudioBase64(): string {
  const dataBytes = 24_000 * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return Buffer.from(bytes).toString('base64');
}

describe('Qwen voice registration route', () => {
  beforeEach(clearQwenVoiceRegistrationMemoForTests);
  afterEach(() => vi.restoreAllMocks());

  it('uses the shared default Qwen base URL when the request omits one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            total_count: 1,
            voice_list: [{ voice: 'voice-1', target_model: 'qwen3-tts-vc-2026-01-22' }],
          },
        }),
      ),
    );
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',
    );
  });

  it('returns a readable message while retaining the typed Qwen error code', async () => {
    // A lookup 5xx is tolerated (falls through to re-register), so surface the
    // Qwen error from the authoritative create action instead.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { total_count: 0, voice_list: [] } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UpstreamFailure' }), { status: 502 }),
      );
    const response = await POST(request(validReferenceAudioBase64()));
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      errorCode: 'QWEN_VC_HTTP_ERROR',
      error: 'Qwen rejected the voice cloning request.',
    });
    expect(body.error).not.toBe(body.errorCode);
  });

  it('returns 400 for invalid reference audio', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output: { total_count: 0, voice_list: [] } })),
    );
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      errorCode: 'QWEN_VC_REFERENCE_AUDIO_INVALID',
      error: expect.stringContaining('24 kHz mono PCM WAV'),
    });
  });

  it('re-registers the cached clip instead of fresh enrollment after an ambiguous lookup', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { total_count: 1, voice_list: [] } })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { total_count: 1, voice_list: [] } })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice: 'voice-1' } })));
    const response = await POST(request(validReferenceAudioBase64()));
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchSpy.mock.calls[2][1]?.body))).toMatchObject({
      input: { action: 'create', preferred_name: expect.any(String) },
    });
  });

  it('re-registers the cached clip when the existence lookup hits a vendor 5xx', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UpstreamFailure' }), { status: 500 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice: 'voice-1' } })));
    const response = await POST(request(validReferenceAudioBase64()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      voiceId: 'voice-1',
      registered: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toMatchObject({
      input: { action: 'create' },
    });
  });

  it('fails loudly when the existence lookup reports an auth error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'InvalidApiKey' }), { status: 401 }),
    );
    const response = await POST(request(validReferenceAudioBase64()));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: 'QWEN_VC_HTTP_ERROR',
    });
  });

  it('shares one route deadline across lookup and enrollment', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const pending = POST(request(validReferenceAudioBase64()));
      await vi.advanceTimersByTimeAsync(29_000);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
