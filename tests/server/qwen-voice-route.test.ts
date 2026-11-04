import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '@/app/api/generate/voice/route';
import { clearQwenVoiceRegistrationMemoForTests } from '@/lib/audio/qwen-voice-clone-registration';

// The Qwen voice-clone adapter now issues requests through undici's fetch with
// a pinned dispatcher, so the vendor double stands in for undici.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

function request(
  referenceAudioBase64 = 'unused-when-voice-exists',
  voiceId = 'cosyvoice-v3.5-plus-voice-1',
): NextRequest {
  return new NextRequest('http://localhost/api/generate/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      providerId: 'qwen-tts',
      voiceId,
      referenceAudioBase64,
      ttsApiKey: 'client-key',
      ttsModelId: 'qwen3-tts-vc-test',
    }),
  });
}

function validReferenceAudioBase64(seconds = 5): string {
  const dataBytes = 24_000 * 2 * seconds;
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
  beforeEach(() => {
    clearQwenVoiceRegistrationMemoForTests();
    fetchMock.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses the shared default Qwen base URL when the request omits one', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            target_model: 'cosyvoice-v3.5-plus',
            status: 'OK',
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
    // A missing voice falls through to re-register; surface the error from create_voice.
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'BadRequest.ResourceNotExist' }), { status: 400 }),
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
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'BadRequest.ResourceNotExist' }), { status: 400 }),
    );
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      errorCode: 'QWEN_VC_REFERENCE_AUDIO_INVALID',
      error: expect.stringContaining('24 kHz mono PCM WAV'),
    });
  });

  it('rejects a short sample with the CosyVoice minimum before creating a voice', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ code: 'BadRequest.ResourceNotExist' }, { status: 400 }),
    );
    const response = await POST(request(validReferenceAudioBase64(4)));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      errorCode: 'QWEN_VC_REFERENCE_AUDIO_INVALID',
      error: expect.stringContaining('between 5 and 60 seconds'),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input.action).toBe('query_voice');
  });

  it('re-registers a saved old voice from its reference clip after migration', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ output: { voice_id: 'cosyvoice-v3.5-plus-migrated-id' } }),
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({ output: { target_model: 'cosyvoice-v3.5-plus', status: 'OK' } }),
    );
    const response = await POST(request(validReferenceAudioBase64(), 'qwen-tts-vc-old'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      voiceId: 'cosyvoice-v3.5-plus-migrated-id',
      registered: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'voice-enrollment',
      input: { action: 'create_voice', target_model: 'cosyvoice-v3.5-plus', prefix: 'qwenttsvco' },
    });
  });

  it.each(['中文老师', 'Sample Teacher'])(
    'enrolls the display name %s without querying it as an ID or requiring a transcript',
    async (name) => {
      fetchMock.mockImplementation(async (_url, init) => {
        const input = JSON.parse(init.body).input;
        if (input.action === 'create_voice')
          return Response.json({ output: { voice_id: 'cosyvoice-v3.5-plus-new-id' } });
        if (input.voice_id === 'cosyvoice-v3.5-plus-new-id')
          return Response.json({ output: { target_model: 'cosyvoice-v3.5-plus', status: 'OK' } });
        return Response.json(
          { code: 'InvalidParameter', message: 'arbitrary wording' },
          { status: 400 },
        );
      });
      const response = await POST(request(validReferenceAudioBase64(), name));
      expect(response.status).toBe(200);
      expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).input.action)).toEqual([
        'create_voice',
        'query_voice',
      ]);
    },
  );

  it('re-registers the cached clip when the existence lookup hits a vendor 5xx', async () => {
    const fetchSpy = fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'UpstreamFailure' }), { status: 500 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice_id: 'voice-1' } })));
    fetchMock.mockResolvedValueOnce(
      Response.json({ output: { target_model: 'cosyvoice-v3.5-plus', status: 'OK' } }),
    );
    const response = await POST(request(validReferenceAudioBase64()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      voiceId: 'voice-1',
      registered: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toMatchObject({
      input: { action: 'create_voice' },
    });
  });

  it('does not re-enroll an existing voice that is still deploying', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ output: { target_model: 'cosyvoice-v3.5-plus', status: 'DEPLOYING' } }),
    );
    const response = await POST(request(validReferenceAudioBase64()));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ errorCode: 'QWEN_VC_VOICE_PROCESSING' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input.action).toBe('query_voice');
  });

  it('returns an actionable audit rejection without enrolling again in the same request', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ output: { target_model: 'cosyvoice-v3.5-plus', status: 'UNDEPLOYED' } }),
    );
    const response = await POST(request(validReferenceAudioBase64()));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      errorCode: 'QWEN_VC_VOICE_REJECTED',
      error: expect.stringContaining('different reference recording'),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input.action).toBe('query_voice');
  });

  it('fails loudly when the existence lookup reports an auth error', async () => {
    fetchMock.mockResolvedValue(
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
      const fetchSpy = fetchMock.mockImplementation(
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
