import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL,
  getManuallySelectableTTSModels,
  QWEN_TTS_VOICE_CLONE_MODEL,
  TTS_PROVIDERS,
} from '@/lib/audio/constants';
import {
  deleteQwenVoice,
  downloadAudio,
  preferredVoiceName,
  qwenVoiceExists,
  registerQwenVoice,
  synthesizeQwenVoiceClone,
} from '@/lib/audio/qwen-voice-clone';
import { resolveQwenVoiceCloneModel } from '@/lib/server/provider-config';
import { clearQwenVoiceRegistrationMemoForTests } from '@/lib/audio/qwen-voice-clone-registration';
import { getVoiceRegistrationAdapter } from '@/lib/audio/voice-registration';
import { getEnabledProvidersWithVoices } from '@/lib/audio/voice-resolver';
import { validateReferenceAudio } from '@/lib/audio/wav-validate';
import { generateTTS } from '@/lib/audio/tts-providers';

// The Qwen voice-clone helpers issue their API calls through undici's fetch
// (with a pinned dispatcher); the audio download keeps using the global fetch.
// One shared double stands in for both so call assertions stay in one place.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});
vi.stubGlobal('fetch', fetchMock);

// `downloadAudio` now runs the URL-layer SSRF guard (then pins the connect via
// the dispatcher). The transport is doubled above, so only the URL-layer DNS
// lookup is reachable; answer it with a public address.
const dnsMocks = vi.hoisted(() => ({ promisesLookup: vi.fn() }));
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    promises: { ...actual.promises, lookup: dnsMocks.promisesLookup },
  };
});

const CONFIG = {
  apiKey: 'sk-qwen',
  baseUrl: 'https://dashscope.example.com/api/v1',
  targetModel: 'cosyvoice-v3.5-plus',
};

function pcmWav(seconds = 5): Uint8Array {
  const dataBytes = Math.round(24_000 * seconds) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24_000, true);
  view.setUint32(28, 48_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function readyVoiceResponse(): Response {
  return Response.json({ output: { target_model: CONFIG.targetModel, status: 'OK' } });
}

describe('Qwen voice cloning', () => {
  beforeEach(() => {
    clearQwenVoiceRegistrationMemoForTests();
    fetchMock.mockReset();
    dnsMocks.promisesLookup.mockReset();
    dnsMocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['query', 'delete'] as const)(
    'uses the default target for adapter %s without a model',
    async (action) => {
      fetchMock.mockResolvedValue(readyVoiceResponse());
      const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
      const cfg = { apiKey: CONFIG.apiKey, baseUrl: CONFIG.baseUrl };
      const voiceId = `${CONFIG.targetModel}-saved-id`;
      if (action === 'query') await expect(adapter.voiceExists(cfg, voiceId)).resolves.toBe(true);
      else await expect(adapter.deleteVoice!(cfg, voiceId)).resolves.toBeUndefined();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual({
        action: `${action}_voice`,
        voice_id: voiceId,
      });
    },
  );

  it('keeps the saved-voice grouping ID while using CosyVoice for new requests', () => {
    expect(QWEN_TTS_VOICE_CLONE_MODEL).toBe('qwen3-tts-vc-2026-01-22');
    expect(DEFAULT_QWEN_TTS_VOICE_CLONE_MODEL).toBe('cosyvoice-v3.5-plus');
    expect(resolveQwenVoiceCloneModel()).toBe('cosyvoice-v3.5-plus');
  });

  it('queries a voice directly and checks its target model and readiness', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: { target_model: 'cosyvoice-v3.5-plus', status: 'OK' },
        }),
      ),
    );
    await expect(
      qwenVoiceExists(
        { ...CONFIG, targetModel: 'cosyvoice-v3.5-plus' },
        'cosyvoice-v3.5-plus-teacher-id',
      ),
    ).resolves.toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: 'voice-enrollment',
      input: { action: 'query_voice', voice_id: 'cosyvoice-v3.5-plus-teacher-id' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('asks users to re-clone an incompatible saved voice before sending a synthesis request', async () => {
    await expect(
      synthesizeQwenVoiceClone(
        { ...CONFIG, targetModel: 'cosyvoice-v3.5-plus' },
        'Hello',
        'qwen-tts-vc-teacher-old',
      ),
    ).rejects.toMatchObject({ code: 'QWEN_VC_RECLONE_REQUIRED', httpStatus: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the enrollment request and uses output.voice_id as the authoritative id', async () => {
    const audio = pcmWav();
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { voice_id: 'qwen_vc_authoritative' } }), {
        status: 200,
      }),
    );

    const result = await registerQwenVoice(CONFIG, {
      name: 'Sample Teacher',
      audio,
    });

    expect(result).toEqual({
      voiceId: 'qwen_vc_authoritative',
      targetModel: 'cosyvoice-v3.5-plus',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://dashscope.example.com/api/v1/services/audio/tts/customization',
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-qwen');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: 'cosyvoice-v3.5-plus',
        prefix: 'sampleteac',
        audio: `data:audio/wav;base64,${Buffer.from(audio).toString('base64')}`,
      },
    });
  });

  it.each([
    'https://dashscope.example.com',
    'https://dashscope.example.com/',
    'https://dashscope.example.com/api/v1',
    'https://dashscope.example.com/api/v1/',
  ])('normalizes base URL %s without duplicating api/v1', async (baseUrl) => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output: { voice_id: 'voice_1' } })),
    );
    await registerQwenVoice({ ...CONFIG, baseUrl }, { name: 'Teacher', audio: pcmWav() });
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://dashscope.example.com/api/v1/services/audio/tts/customization',
    );
  });

  it('creates stable constrained preferred names', () => {
    const first = preferredVoiceName('A Name With Spaces');
    const second = preferredVoiceName('A Name With Spaces');
    expect(first).toBe(second);
    expect(first).toBe('anamewiths');
    expect(first.length).toBeLessThanOrEqual(10);
    expect(preferredVoiceName('!!!')).toBe('openmaic');
    expect(preferredVoiceName('007 Agent')).toBe('007agent');
  });

  it.each([
    'http://127.0.0.1/private.wav',
    'https://example.com/result.wav',
    'ftp://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8443/result.wav',
  ])('rejects an untrusted audio URL: %s', async (url) => {
    const fetchSpy = fetchMock;
    await expect(downloadAudio(url)).rejects.toMatchObject({
      code: 'QWEN_VC_AUDIO_URL_INVALID',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('upgrades trusted HTTP URLs and refuses redirects', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    await downloadAudio(
      'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav?signature=value',
    );
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav?signature=value',
    );
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('allows international DashScope result hosts', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), { status: 200 }),
    );
    await downloadAudio('https://dashscope-result-us.oss-us-west-1.aliyuncs.com/result.wav');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('rejects an oversized declared download before reading it', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-length': String(50 * 1024 * 1024 + 1) },
      }),
    );
    await expect(
      downloadAudio('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav'),
    ).rejects.toMatchObject({ code: 'QWEN_VC_AUDIO_TOO_LARGE' });
  });

  it('stops a chunked download when the streaming cap is crossed', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(30 * 1024 * 1024));
        controller.enqueue(new Uint8Array(21 * 1024 * 1024));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    await expect(
      downloadAudio('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav'),
    ).rejects.toMatchObject({ code: 'QWEN_VC_AUDIO_TOO_LARGE' });
  });

  it('returns downloaded WAV bytes from CosyVoice synthesis', async () => {
    const fetchSpy = fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              audio: {
                url: 'https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/a.wav',
                format: 'wav',
              },
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        }),
      );

    const result = await synthesizeQwenVoiceClone(CONFIG, 'Hello', 'cosyvoice-v3.5-plus-test-id');
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://dashscope.example.com/api/v1/services/audio/tts/SpeechSynthesizer',
    );
    expect(result).toEqual({ audio: new Uint8Array([82, 73, 70, 70]), format: 'wav' });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
      model: 'cosyvoice-v3.5-plus',
      input: {
        text: 'Hello',
        voice: 'cosyvoice-v3.5-plus-test-id',
        format: 'wav',
        sample_rate: 24000,
      },
    });
  });

  it('normalizes non-default VC speed and still synthesizes', async () => {
    const fetchSpy = fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              audio: { url: 'https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/a.wav' },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    await expect(
      synthesizeQwenVoiceClone(CONFIG, 'Hello', 'cosyvoice-v3.5-plus-test-id', 1.25),
    ).resolves.toEqual({
      audio: new Uint8Array([1]),
      format: 'wav',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('allows a custom Qwen base URL to serve its own audio without weakening redirects', async () => {
    const fetchSpy = fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1]), { status: 200 }),
    );
    await downloadAudio(
      'https://proxy.example.com/storage/result.wav',
      undefined,
      'https://proxy.example.com/api/v1',
    );
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('deletes a provider-side voice with the current request shape', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ output: {} })));
    await expect(deleteQwenVoice(CONFIG, 'cosyvoice-v3.5-plus-test-id')).resolves.toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      model: 'voice-enrollment',
      input: { action: 'delete_voice', voice_id: 'cosyvoice-v3.5-plus-test-id' },
    });
  });

  it('does not reuse a voice registered for a different target model', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: { target_model: 'cosyvoice-v3-plus', status: 'OK' },
        }),
      ),
    );
    await expect(qwenVoiceExists(CONFIG, 'v1')).resolves.toBe(false);
  });

  it('does not silently re-register a voice still being processed', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          output: { target_model: 'cosyvoice-v3.5-plus', status: 'DEPLOYING' },
        }),
      ),
    );
    await expect(qwenVoiceExists(CONFIG, 'v1')).rejects.toMatchObject({
      code: 'QWEN_VC_VOICE_PROCESSING',
      httpStatus: 409,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('treats a provider resource-not-found response as a missing voice', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'BadRequest.ResourceNotExist',
          message: 'The Required resource not exist',
        }),
        { status: 400 },
      ),
    );
    await expect(qwenVoiceExists(CONFIG, 'qwen-tts-vc-old')).resolves.toBe(false);
  });

  it('treats a vendor 5xx on the existence lookup as unknown', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'UpstreamFailure' }), { status: 500 }),
    );
    await expect(qwenVoiceExists(CONFIG, 'v1')).resolves.toBe('unknown');
  });

  it('treats a network error on the existence lookup as unknown', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(qwenVoiceExists(CONFIG, 'v1')).resolves.toBe('unknown');
  });

  it('fails loudly on a 401 existence lookup', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'InvalidApiKey' }), { status: 401 }),
    );
    await expect(qwenVoiceExists(CONFIG, 'v1')).rejects.toMatchObject({
      code: 'QWEN_VC_HTTP_ERROR',
      httpStatus: 401,
    });
  });

  describe('registration readiness', () => {
    const nameAliases = [
      ['A B', 'AB'],
      ['A-B', 'AB'],
      ['ab', 'AB'],
      ['Áb', 'Ab'],
      ['abcdefghij-one', 'abcdefghij-two'],
    ];
    const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
    const params = {
      voiceId: 'Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      refText: 'Reference transcript.',
    };
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    afterEach(() => vi.useRealTimers());

    it.each(['audio', 'account', 'model', 'endpoint', 'policy', 'name'] as const)(
      'keeps registrations isolated by %s',
      async (dimension) => {
        const targets = new Map<string, string>();
        fetchMock.mockImplementation(async (_url, init) => {
          const input = JSON.parse(init.body).input;
          if (input.action === 'create_voice') {
            const id = `voice-${targets.size}`;
            targets.set(id, input.target_model);
            return Response.json({ output: { voice_id: id } });
          }
          return Response.json({
            output: { target_model: targets.get(input.voice_id), status: 'OK' },
          });
        });
        const otherCfg = {
          ...cfg,
          ...(dimension === 'account' ? { apiKey: 'other-account' } : {}),
          ...(dimension === 'model' ? { model: 'cosyvoice-v3-plus' } : {}),
          ...(dimension === 'endpoint' ? { baseUrl: 'https://another.example.com/api/v1' } : {}),
          ...(dimension === 'policy' ? { publicOnly: true } : {}),
        };
        const audio = Buffer.from(pcmWav());
        audio[audio.length - 1] = 1;
        const otherParams = {
          ...params,
          refText: 'Changed transcript.',
          ...(dimension === 'audio' ? { referenceAudioBase64: audio.toString('base64') } : {}),
          ...(dimension === 'name' ? { voiceId: 'Other teacher' } : {}),
        };
        expect(await adapter.registerVoice(cfg, params)).toBe('voice-0');
        expect(await adapter.registerVoice(otherCfg, otherParams)).toBe('voice-1');
        expect(targets.size).toBe(2);
      },
    );

    it('coalesces equivalent base64 encodings of the same audio', async () => {
      fetchMock.mockImplementation(async (_url, init) =>
        JSON.parse(init.body).input.action === 'create_voice'
          ? Response.json({ output: { voice_id: 'same-audio' } })
          : readyVoiceResponse(),
      );
      const wrapped = params.referenceAudioBase64.match(/.{1,80}/g)!.join('\n');
      await expect(
        Promise.all([
          adapter.registerVoice(cfg, params),
          adapter.registerVoice(cfg, { ...params, referenceAudioBase64: wrapped }),
        ]),
      ).resolves.toEqual(['same-audio', 'same-audio']);
      expect(
        fetchMock.mock.calls.filter(
          ([, init]) => JSON.parse(init.body).input.action === 'create_voice',
        ),
      ).toHaveLength(1);
    });

    it.each(nameAliases)(
      'shares concurrent and ready registration for %s / %s',
      async (firstName, secondName) => {
        fetchMock.mockImplementation(async (_url, init) =>
          JSON.parse(init.body).input.action === 'create_voice'
            ? Response.json({ output: { voice_id: 'shared-prefix' } })
            : readyVoiceResponse(),
        );
        await expect(
          Promise.all([
            adapter.registerVoice(cfg, { ...params, voiceId: firstName }),
            adapter.registerVoice(cfg, {
              ...params,
              voiceId: secondName,
              refText: 'Edited transcript.',
            }),
          ]),
        ).resolves.toEqual(['shared-prefix', 'shared-prefix']);
        await expect(
          adapter.registerVoice(cfg, {
            ...params,
            voiceId: secondName,
            refText: 'Third transcript.',
          }),
        ).resolves.toBe('shared-prefix');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(
          fetchMock.mock.calls.filter(
            ([, init]) => JSON.parse(init.body).input.action === 'create_voice',
          ),
        ).toHaveLength(1);
      },
    );

    it('waits through deployment before exposing a created voice', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'pending-id' } }))
        .mockResolvedValueOnce(
          Response.json({ output: { target_model: CONFIG.targetModel, status: 'DEPLOYING' } }),
        )
        .mockResolvedValueOnce(
          Response.json({ output: { target_model: CONFIG.targetModel, status: 'OK' } }),
        );
      let settled = false;
      const pending = adapter.registerVoice(cfg, params).then((id) => {
        settled = true;
        return id;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toBe('pending-id');
    });

    it.each(nameAliases)(
      'retains pending identity for %s / %s across the budget',
      async (firstName, secondName) => {
        vi.useFakeTimers();
        let ready = false;
        const actions: string[] = [];
        fetchMock.mockImplementation(async (_url, init) => {
          const action = JSON.parse(init.body).input.action;
          actions.push(action);
          return Response.json({
            output:
              action === 'create_voice'
                ? { voice_id: 'pending-id' }
                : { target_model: CONFIG.targetModel, status: ready ? 'OK' : 'DEPLOYING' },
          });
        });
        const pending = expect(
          adapter.registerVoice(cfg, { ...params, voiceId: firstName }),
        ).rejects.toMatchObject({
          code: 'QWEN_VC_VOICE_PROCESSING',
        });
        await vi.advanceTimersByTimeAsync(25_000);
        await pending;
        fetchMock.mockResolvedValueOnce(
          Response.json({ code: 'UpstreamFailure' }, { status: 503 }),
        );
        await expect(adapter.voiceExists(cfg, 'pending-id')).resolves.toBe('unknown');
        ready = true;
        await expect(
          adapter.registerVoice(cfg, {
            ...params,
            voiceId: secondName,
            refText: 'Corrected transcript.',
          }),
        ).resolves.toBe('pending-id');
        expect(actions.filter((action) => action === 'create_voice')).toHaveLength(1);
      },
    );

    it.each([
      [
        { output: { target_model: 'another-model', status: 'OK' } },
        200,
        'QWEN_VC_RECLONE_REQUIRED',
      ],
      [{ code: 'InvalidApiKey' }, 401, 'QWEN_VC_HTTP_ERROR'],
    ])('does not mark a rejected readiness query ready: %j', async (body, status, code) => {
      fetchMock
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'pending-id' } }))
        .mockImplementation(async () => Response.json(body, { status }));
      await expect(adapter.registerVoice(cfg, params)).rejects.toMatchObject({ code });
      await expect(adapter.registerVoice(cfg, params)).rejects.toMatchObject({ code });
      expect(
        fetchMock.mock.calls.filter(
          ([, init]) => JSON.parse(init.body).input.action === 'create_voice',
        ),
      ).toHaveLength(1);
    });

    it('clears an audit-rejected enrollment so a corrected sample can be registered', async () => {
      fetchMock
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'rejected-id' } }))
        .mockResolvedValueOnce(
          Response.json({ output: { target_model: CONFIG.targetModel, status: 'UNDEPLOYED' } }),
        )
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'replacement-id' } }))
        .mockResolvedValueOnce(readyVoiceResponse());
      await expect(adapter.registerVoice(cfg, params)).rejects.toMatchObject({
        code: 'QWEN_VC_VOICE_REJECTED',
      });
      await expect(adapter.registerVoice(cfg, params)).resolves.toBe('replacement-id');
      expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).input.action)).toEqual([
        'create_voice',
        'query_voice',
        'create_voice',
        'query_voice',
      ]);
    });

    it('evicts a previously ready memo when a fresh lookup reports audit rejection', async () => {
      fetchMock
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'saved-id' } }))
        .mockResolvedValueOnce(readyVoiceResponse());
      await adapter.registerVoice(cfg, params);
      fetchMock.mockResolvedValueOnce(
        Response.json({ output: { target_model: CONFIG.targetModel, status: 'UNDEPLOYED' } }),
      );
      await expect(adapter.voiceExists(cfg, 'saved-id')).rejects.toMatchObject({
        code: 'QWEN_VC_VOICE_REJECTED',
      });
      fetchMock
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'new-id' } }))
        .mockResolvedValueOnce(readyVoiceResponse());
      await expect(adapter.registerVoice(cfg, params)).resolves.toBe('new-id');
    });

    it('registers without transcript metadata', async () => {
      fetchMock
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'sample-id' } }))
        .mockResolvedValueOnce(readyVoiceResponse());
      await expect(adapter.registerVoice(cfg, { ...params, refText: undefined })).resolves.toBe(
        'sample-id',
      );
    });

    it.each(['中文老师', 'Sample Teacher', 'qwen-tts-vc-old-id', 'cosyvoice-v3-plus-foreign-id'])(
      'does not query a display name or incompatible saved ID during preflight: %s',
      async (name) => {
        fetchMock.mockResolvedValue(
          Response.json(
            { code: 'InvalidParameter', message: 'arbitrary provider wording' },
            { status: 400 },
          ),
        );
        await expect(adapter.voiceExists(cfg, name)).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('allows a new enrollment only after an authoritative missing pending voice', async () => {
      fetchMock
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'deleted-id' } }))
        .mockResolvedValueOnce(
          Response.json({ code: 'BadRequest.ResourceNotExist' }, { status: 400 }),
        )
        .mockResolvedValueOnce(Response.json({ output: { voice_id: 'replacement-id' } }))
        .mockResolvedValueOnce(readyVoiceResponse());
      await expect(adapter.registerVoice(cfg, params)).rejects.toMatchObject({
        code: 'QWEN_VC_VOICE_NOT_FOUND',
      });
      await expect(adapter.registerVoice(cfg, params)).resolves.toBe('replacement-id');
      expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).input.action)).toEqual([
        'create_voice',
        'query_voice',
        'create_voice',
        'query_voice',
      ]);
    });

    function delayedCreate(signal: AbortSignal, ms: number, bodyLate: boolean): Promise<Response> {
      const body = JSON.stringify({ output: { voice_id: 'late-id' } });
      if (bodyLate) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                const aborted = () => {
                  clearTimeout(timer);
                  controller.error(signal.reason);
                };
                const timer = setTimeout(() => {
                  signal.removeEventListener('abort', aborted);
                  controller.enqueue(new TextEncoder().encode(body));
                  controller.close();
                }, ms);
                signal.addEventListener('abort', aborted, { once: true });
              },
            }),
          ),
        );
      }
      return new Promise((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', aborted);
          resolve(new Response(body));
        }, ms);
        signal.addEventListener('abort', aborted, { once: true });
      });
    }

    it.each(
      nameAliases.flatMap(([firstName, secondName]) =>
        [false, true].map((bodyLate) => ({ firstName, secondName, bodyLate })),
      ),
    )(
      'reconciles late create for $firstName / $secondName (late body $bodyLate)',
      async ({ firstName, secondName, bodyLate }) => {
        vi.useFakeTimers();
        let createSignal!: AbortSignal;
        fetchMock
          .mockImplementationOnce((_url, init) => {
            createSignal = init.signal;
            return delayedCreate(createSignal, 25_000, bodyLate);
          })
          .mockImplementation(async () => readyVoiceResponse());
        const pending = expect(
          adapter.registerVoice(cfg, {
            ...params,
            voiceId: firstName,
            refText: 'Revised transcript.',
          }),
        ).rejects.toMatchObject({
          code: 'QWEN_VC_TIMEOUT',
        });
        await vi.advanceTimersByTimeAsync(23_000);
        await pending;
        expect(createSignal.aborted).toBe(false);
        await expect(
          adapter.registerVoice(cfg, { ...params, voiceId: secondName }),
        ).rejects.toMatchObject({
          code: 'QWEN_VC_TIMEOUT',
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fetchMock).toHaveBeenCalledOnce(); // No readiness work after the budget expired.
        await expect(adapter.registerVoice(cfg, { ...params, voiceId: secondName })).resolves.toBe(
          'late-id',
        );
        expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).input)).toMatchObject([
          { action: 'create_voice' },
          { action: 'query_voice', voice_id: 'late-id' },
        ]);
      },
    );

    it.each([false, true])(
      'retains the independent 30s create transport limit (late body %s)',
      async (bodyLate) => {
        vi.useFakeTimers();
        let createSignal!: AbortSignal;
        fetchMock.mockImplementationOnce((_url, init) => {
          createSignal = init.signal;
          return delayedCreate(createSignal, 35_000, bodyLate);
        });
        const pending = expect(adapter.registerVoice(cfg, params)).rejects.toMatchObject({
          code: 'QWEN_VC_TIMEOUT',
        });
        await vi.advanceTimersByTimeAsync(23_000);
        await pending;
        expect(createSignal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(7_000);
        expect(createSignal.aborted).toBe(true);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('shares a finite deadline across create and a stalled readiness query', async () => {
      vi.useFakeTimers();
      let querySignal: AbortSignal | undefined;
      fetchMock
        .mockImplementationOnce(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve(Response.json({ output: { voice_id: 'pending-id' } })),
                20_000,
              ),
            ),
        )
        .mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              querySignal = init.signal;
              init.signal.addEventListener('abort', () => reject(init.signal.reason), {
                once: true,
              });
            }),
        );
      const pending = expect(adapter.registerVoice(cfg, params)).rejects.toMatchObject({
        code: 'QWEN_VC_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(25_000);
      await pending;
      expect(querySignal?.aborted).toBe(true);
    });
  });

  it('does not couple a shared enrollment to the first waiter aborting', async () => {
    let resolveVendor!: (response: Response) => void;
    const fetchSpy = fetchMock
      .mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
            resolveVendor = resolve;
          }),
      )
      .mockImplementation(async () => readyVoiceResponse());
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const params = {
      voiceId: 'Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      refText: 'Reference transcript.',
    };
    const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
    const firstController = new AbortController();
    const first = adapter.registerVoice(cfg, params, firstController.signal);
    const second = adapter.registerVoice(cfg, params);
    firstController.abort(new DOMException('Caller disconnected', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    resolveVendor(new Response(JSON.stringify({ output: { voice_id: 'vendor_voice' } })));
    await expect(second).resolves.toBe('vendor_voice');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('memoizes a background enrollment after its only waiter aborts', async () => {
    let resolveVendor!: (response: Response) => void;
    const fetchSpy = fetchMock
      .mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
            resolveVendor = resolve;
          }),
      )
      .mockImplementation(async () => readyVoiceResponse());
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const params = {
      voiceId: 'Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      refText: 'Reference transcript.',
    };
    const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
    const controller = new AbortController();
    const waiter = adapter.registerVoice(cfg, params, controller.signal);
    controller.abort(new DOMException('Route timed out', 'AbortError'));
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });

    resolveVendor(new Response(JSON.stringify({ output: { voice_id: 'vendor_voice' } })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(adapter.registerVoice(cfg, params)).resolves.toBe('vendor_voice');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('bounds the successful registration memo and evicts the least recently used entry', async () => {
    const fetchSpy = fetchMock.mockImplementation(async (_url, init) =>
      JSON.parse(init.body).input.action === 'create_voice'
        ? Response.json({ output: { voice_id: 'vendor_voice' } })
        : readyVoiceResponse(),
    );
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
    const referenceAudioBase64 = Buffer.from(pcmWav()).toString('base64');
    for (let index = 0; index < 257; index++) {
      await adapter.registerVoice(cfg, {
        voiceId: `Teacher ${index}`,
        referenceAudioBase64,
        refText: 'Reference transcript.',
      });
    }
    await adapter.registerVoice(cfg, {
      voiceId: 'Teacher 0',
      referenceAudioBase64,
      refText: 'Reference transcript.',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(516);
  });

  it('uses a successful memo to avoid duplicate enrollment after an ambiguous lookup', async () => {
    const fetchSpy = fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice_id: 'vendor_voice' } })))
      .mockResolvedValueOnce(readyVoiceResponse())
      .mockImplementation(
        async () => new Response(JSON.stringify({ code: 'UpstreamFailure' }), { status: 503 }),
      );
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
    await adapter.registerVoice(cfg, {
      voiceId: 'Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      refText: 'Reference transcript.',
    });
    await expect(adapter.voiceExists(cfg, 'vendor_voice')).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(
      fetchSpy.mock.calls.filter(
        ([, init]) => JSON.parse(String(init?.body)).input.action === 'create_voice',
      ),
    ).toHaveLength(1);
  });

  it('does not use an ambiguous registration memo from another account', async () => {
    const fetchSpy = fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice_id: 'vendor_voice' } })))
      .mockResolvedValueOnce(readyVoiceResponse())
      .mockImplementation(
        async () => new Response(JSON.stringify({ code: 'UpstreamFailure' }), { status: 503 }),
      );
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const accountA = { baseUrl: CONFIG.baseUrl, apiKey: 'account-a', model: CONFIG.targetModel };
    const accountB = { baseUrl: CONFIG.baseUrl, apiKey: 'account-b', model: CONFIG.targetModel };
    await adapter.registerVoice(accountA, {
      voiceId: 'Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      refText: 'Reference transcript.',
    });

    await expect(adapter.voiceExists(accountB, 'vendor_voice')).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each(['account', 'endpoint'])(
    'keeps another %s memo when the same provider ID is rejected',
    async (dimension) => {
      const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
      const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
      const other = {
        ...cfg,
        ...(dimension === 'account'
          ? { apiKey: 'other-key' }
          : { baseUrl: 'https://other.example.com/api/v1' }),
      };
      const params = {
        voiceId: 'Teacher',
        referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      };
      for (const connection of [cfg, other]) {
        fetchMock
          .mockResolvedValueOnce(Response.json({ output: { voice_id: 'shared-id' } }))
          .mockResolvedValueOnce(readyVoiceResponse());
        await adapter.registerVoice(connection, params);
      }
      fetchMock.mockResolvedValueOnce(
        Response.json({ output: { target_model: CONFIG.targetModel, status: 'UNDEPLOYED' } }),
      );
      await expect(adapter.voiceExists(other, 'shared-id')).rejects.toMatchObject({
        code: 'QWEN_VC_VOICE_REJECTED',
      });
      fetchMock.mockReset();
      await expect(adapter.registerVoice(cfg, params)).resolves.toBe('shared-id');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('does not use an expired memo after an ambiguous lookup', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchSpy = fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ output: { voice_id: 'vendor_voice' } })))
      .mockResolvedValueOnce(readyVoiceResponse())
      .mockImplementation(
        async () => new Response(JSON.stringify({ code: 'UpstreamFailure' }), { status: 503 }),
      );
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
    await adapter.registerVoice(cfg, {
      voiceId: 'Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      refText: 'Reference transcript.',
    });
    now += 60 * 60 * 1000 + 1;

    await expect(adapter.voiceExists(cfg, 'vendor_voice')).resolves.toBe('unknown');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('dispatches a configured ordinary voice through the normal Qwen API', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ output: { audio: { url: 'https://dashscope.example.com/audio.wav' } } }),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    await generateTTS(
      {
        providerId: 'qwen-tts',
        modelId: 'qwen3-tts',
        voice: 'vivian',
        voices: [{ id: 'vivian', name: 'Vivian' }],
        speed: 1.25,
        apiKey: CONFIG.apiKey,
        baseUrl: CONFIG.baseUrl,
      },
      'Hello',
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/services/aigc/multimodal-generation/generation',
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe('qwen3-tts');
    expect(body.input.voice).toBe('vivian');
    expect(body.parameters.rate).toBe(125);
  });

  it('dispatches from the voice identity, not a stale model id', async () => {
    const fetchSpy = fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              audio: {
                url: 'https://dashscope.example.com/audio.wav',
              },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));

    await generateTTS(
      {
        providerId: 'qwen-tts',
        modelId: QWEN_TTS_VOICE_CLONE_MODEL,
        voice: 'Cherry',
        speed: 1,
        apiKey: CONFIG.apiKey,
        baseUrl: CONFIG.baseUrl,
      },
      'Hello',
    );
    const requestBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(requestBody.model).toBe('qwen3-tts-flash');
    expect(requestBody.input).toMatchObject({ voice: 'Cherry', language_type: 'Chinese' });
    expect(requestBody.parameters).toBeDefined();
  });

  it('uses a neutral error identity for ordinary Qwen audio download failures', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ output: { audio: { url: 'https://untrusted.example.com/audio.wav' } } }),
      ),
    );
    await expect(
      generateTTS(
        {
          providerId: 'qwen-tts',
          modelId: 'qwen3-tts-flash',
          voice: 'Cherry',
          speed: 1,
          apiKey: CONFIG.apiKey,
          baseUrl: CONFIG.baseUrl,
        },
        'Hello',
      ),
    ).rejects.toMatchObject({
      code: 'QWEN_TTS_ERROR',
      message: 'The generated Qwen audio URL host "untrusted.example.com" is not allowed.',
    });
  });

  it('evicts the registration memo when synthesis reports that the voice is gone', async () => {
    const fetchSpy = fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { voice_id: 'cosyvoice-v3.5-plus-vendor-one' } })),
      )
      .mockResolvedValueOnce(readyVoiceResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'VoiceNotFound', message: 'voice does not exist' }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output: { voice_id: 'cosyvoice-v3.5-plus-vendor-two' } })),
      )
      .mockResolvedValueOnce(readyVoiceResponse());
    const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
    const params = {
      voiceId: 'Teacher',
      referenceAudioBase64: Buffer.from(pcmWav()).toString('base64'),
      refText: 'Reference transcript.',
    };
    const cfg = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel };
    await expect(adapter.registerVoice(cfg, params)).resolves.toBe(
      'cosyvoice-v3.5-plus-vendor-one',
    );
    await expect(
      generateTTS(
        {
          providerId: 'qwen-tts',
          modelId: CONFIG.targetModel,
          voice: 'cosyvoice-v3.5-plus-vendor-one',
          speed: 1.25,
          apiKey: CONFIG.apiKey,
          baseUrl: CONFIG.baseUrl,
        },
        'Hello',
      ),
    ).rejects.toMatchObject({ code: 'QWEN_VC_VOICE_NOT_FOUND' });
    await expect(adapter.registerVoice(cfg, params)).resolves.toBe(
      'cosyvoice-v3.5-plus-vendor-two',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('shares a synthesis deadline across the vendor request and download', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const pending = synthesizeQwenVoiceClone(CONFIG, 'Hello', 'cosyvoice-v3.5-plus-test-id');
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'QWEN_VC_TIMEOUT',
        httpStatus: 504,
      });
      await vi.advanceTimersByTimeAsync(24_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1, 4, 4.999])(
    'rejects a %s-second CosyVoice sample before enrollment',
    async (seconds) => {
      const adapter = getVoiceRegistrationAdapter('qwen-tts')!;
      fetchMock.mockResolvedValue(Response.json({ output: { voice_id: 'unexpected-voice' } }));
      await expect(
        adapter.registerVoice(
          { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, model: CONFIG.targetModel },
          {
            voiceId: 'Short sample',
            referenceAudioBase64: Buffer.from(pcmWav(seconds)).toString('base64'),
            refText: 'Hello',
          },
        ),
      ).rejects.toMatchObject({
        code: 'QWEN_VC_REFERENCE_AUDIO_INVALID',
        message: expect.stringContaining('between 5 and 60 seconds'),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('validates 24 kHz mono PCM WAV reference audio', () => {
    expect(validateReferenceAudio(pcmWav(2))).toEqual({
      durationSeconds: 2,
      sampleRate: 24_000,
      channels: 1,
    });
    const invalid = pcmWav();
    new DataView(invalid.buffer).setUint32(24, 16_000, true);
    expect(() => validateReferenceAudio(invalid)).toThrowError(
      'Reference audio must be a 24 kHz mono PCM WAV file between 1 and 60 seconds long',
    );
  });

  it.each(['qwen-tts-vc-legacy', 'cosyvoice-v3.5-plus-vendor-one'])(
    'keeps saved voice %s visible in the legacy clone group',
    (voiceId) => {
      const qwen = getEnabledProvidersWithVoices({ 'qwen-tts': { apiKey: 'key', enabled: true } }, [
        {
          id: voiceId,
          providerId: 'qwen-tts',
          kind: 'clone',
          name: 'Saved voice',
        },
      ]).find((provider) => provider.providerId === 'qwen-tts')!;

      expect(qwen.voices).toContainEqual({
        id: voiceId,
        name: 'Saved voice',
        language: 'auto',
      });
      expect(
        qwen.modelGroups.find((group) => group.modelId === QWEN_TTS_VOICE_CLONE_MODEL)?.voices,
      ).toEqual([{ id: voiceId, name: 'Saved voice', language: 'auto' }]);
      expect(
        qwen.modelGroups.find((group) => group.modelId === 'qwen3-tts-flash')?.voices,
      ).not.toContainEqual(expect.objectContaining({ id: voiceId }));
    },
  );

  it('excludes the voice-clone model from manual model options but keeps it in the registry', () => {
    const qwenModels = TTS_PROVIDERS['qwen-tts'].models;
    // The registry entry stays so voice-driven dispatch can still resolve it.
    expect(qwenModels.some((model) => model.id === QWEN_TTS_VOICE_CLONE_MODEL)).toBe(true);

    const manualModels = getManuallySelectableTTSModels('qwen-tts');
    expect(manualModels.some((model) => model.id === QWEN_TTS_VOICE_CLONE_MODEL)).toBe(false);
    expect(manualModels.length).toBe(qwenModels.length - 1);
    // Non-clone models remain selectable.
    expect(manualModels.map((model) => model.id)).toContain('qwen3-tts-flash');
    // Other providers are unaffected by the filter.
    expect(getManuallySelectableTTSModels('openai-tts')).toEqual(
      TTS_PROVIDERS['openai-tts'].models,
    );
  });
});
