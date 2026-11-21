import { beforeEach, describe, expect, it, vi } from 'vitest';

import { minimaxVoiceRegistrationAdapter as adapter } from '@/lib/audio/minimax-voice-registration';
import { pcmS16leMonoToWav } from '@/lib/audio/pcm-wav';
import { generateTTS } from '@/lib/audio/tts-providers';

// Double the network transport below the real endpoint policy and multipart conversion.
const transport = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: transport,
}));

const account = {
  apiKey: 'personal-test-key',
  baseUrl: 'https://gateway.example/minimax/v1/',
  publicOnly: true,
};
const success = { status_code: 0, status_msg: 'success' };
function response(data: Record<string, unknown> = {}): Response {
  return Response.json({ base_resp: success, ...data });
}

function sample(seconds = 10, sampleRate = 24_000): Buffer {
  const pcm = new Uint8Array(seconds * sampleRate * 2);
  return Buffer.from(pcmS16leMonoToWav(pcm, sampleRate));
}

describe('MiniMax account voices', () => {
  beforeEach(() => transport.mockReset());

  it('lists system, cloned, and designed voices on the configured gateway', async () => {
    transport.mockResolvedValueOnce(
      response({
        system_voice: [
          {
            voice_id: 'Chinese (Mandarin)_News_Anchor',
            voice_name: '新闻女声',
            description: ['播音腔'],
          },
        ],
        voice_cloning: [{ voice_id: 'teacher-2026', description: [] }],
        voice_generation: [{ voice_id: 'ttv-designed', description: ['讲解员'] }],
      }),
    );

    await expect(adapter.listVoices!(account)).resolves.toEqual([
      { id: 'Chinese (Mandarin)_News_Anchor', name: '新闻女声', kind: 'system' },
      { id: 'teacher-2026', name: 'teacher-2026', kind: 'clone' },
      { id: 'ttv-designed', name: '讲解员', kind: 'designed' },
    ]);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://gateway.example/minimax/v1/get_voice');
    expect(init!.method).toBe('POST');
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer personal-test-key');
    expect(JSON.parse(String(init!.body))).toEqual({ voice_type: 'all' });
  });

  it('accepts empty voice categories and falls back to a usable voice ID', async () => {
    transport.mockResolvedValueOnce(
      response({
        system_voice: null,
        voice_cloning: [{ voice_id: 'teacher-2026', voice_name: null, description: null }],
        voice_generation: null,
      }),
    );
    await expect(adapter.listVoices!(account)).resolves.toEqual([
      { id: 'teacher-2026', name: 'teacher-2026', kind: 'clone' },
    ]);
  });

  it('never uses a registration label to discover or reuse someone’s existing voice', async () => {
    const managed = { ...account, managed: true };
    await expect(adapter.voiceExists(managed, '别人的音色')).resolves.toBe('unknown');
    await expect(adapter.voiceExists(account, 'female-yujie')).resolves.toBe('unknown');
    await expect(adapter.listVoices!(managed)).rejects.toThrow();
    await expect(
      adapter.deleteVoice!(managed, 'teacher-2026', undefined, 'clone'),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('sends the reference WAV, then clones under a fresh vendor ID without a synthesis request', async () => {
    const audio = sample();
    const cfg = { ...account, baseUrl: 'https://regional.example/proxy', managed: true };
    const params = { voiceId: '中文名 / 讲师★', referenceAudioBase64: audio.toString('base64') };
    transport
      .mockResolvedValueOnce(
        response({ file: { file_id: 319872001234567, purpose: 'voice_clone' } }),
      )
      .mockResolvedValueOnce(response({ input_sensitive: false, demo_audio: '' }));

    const voiceId = await adapter.registerVoice(cfg, params);
    expect(voiceId).toMatch(/^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/);
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      'https://regional.example/proxy/v1/files/upload',
      'https://regional.example/proxy/v1/voice_clone',
    ]);
    const upload = transport.mock.calls[0][1]!;
    expect(upload.method).toBe('POST');
    expect(new Headers(upload.headers).get('authorization')).toBe('Bearer personal-test-key');
    const form = upload.body as FormData;
    expect(form.get('purpose')).toBe('voice_clone');
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/wav');
    expect(Buffer.from(await file.arrayBuffer()).equals(audio)).toBe(true);
    const clone = transport.mock.calls[1][1]!;
    expect(JSON.parse(String(clone.body))).toEqual({ file_id: 319872001234567, voice_id: voiceId });
  });

  it('coalesces concurrent personal requests and issues a fresh ID when re-cloning a deleted voice', async () => {
    transport.mockImplementation(async (url) =>
      String(url).endsWith('/files/upload') ? response({ file: { file_id: 42 } }) : response(),
    );
    const params = { voiceId: 'Tutor', referenceAudioBase64: sample().toString('base64') };
    const first = adapter.registerVoice(account, params);
    const second = adapter.registerVoice(account, params);
    const id = await first;
    expect(await second).toBe(id);
    expect(transport).toHaveBeenCalledTimes(2);
    await adapter.deleteVoice!(account, id, undefined, 'clone');
    expect(await adapter.registerVoice(account, params)).not.toBe(id);
  });

  it.each([false, true])('stops after a canceled upload (managed: %s)', async (managed) => {
    const upload = Promise.withResolvers<Response>();
    transport.mockReturnValueOnce(upload.promise).mockResolvedValueOnce(response());
    const controller = new AbortController();
    const params = { voiceId: 'Tutor', referenceAudioBase64: sample().toString('base64') };
    const registration = adapter.registerVoice({ ...account, managed }, params, controller.signal);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    const reason = new Error('Upload canceled');
    const canceled = expect(registration).rejects.toBe(reason);
    controller.abort(reason);
    upload.resolve(response({ file: { file_id: 41 } }));
    await canceled;
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('finishes a shared registration for the caller who stays', async () => {
    const upload = Promise.withResolvers<Response>();
    transport.mockReturnValueOnce(upload.promise).mockResolvedValueOnce(response());
    const controller = new AbortController();
    const params = { voiceId: 'Tutor', referenceAudioBase64: sample().toString('base64') };
    const departing = adapter.registerVoice(account, params, controller.signal);
    const staying = adapter.registerVoice(account, params);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    const canceled = expect(departing).rejects.toThrow('Caller left');
    controller.abort(new Error('Caller left'));
    await canceled;
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(false);
    upload.resolve(response({ file: { file_id: 42 } }));
    const id = await staying;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(transport.mock.calls[1][1]?.body))).toEqual({
      file_id: 42,
      voice_id: id,
    });
  });

  it('starts an independent retry as soon as the last waiter cancels', async () => {
    const oldUpload = Promise.withResolvers<Response>();
    const retryUpload = Promise.withResolvers<Response>();
    let uploads = 0;
    transport.mockImplementation(async (url) => {
      if (String(url).endsWith('/files/upload')) {
        uploads++;
        return uploads === 1 ? oldUpload.promise : retryUpload.promise;
      }
      return response();
    });
    const first = new AbortController();
    const last = new AbortController();
    const params = { voiceId: 'Tutor', referenceAudioBase64: sample().toString('base64') };
    const waiters = [first, last].map((controller) =>
      expect(adapter.registerVoice(account, params, controller.signal)).rejects.toThrow('Canceled'),
    );
    await vi.waitFor(() => expect(uploads).toBe(1));

    first.abort(new Error('Canceled'));
    last.abort(new Error('Canceled'));
    const retry = adapter.registerVoice(account, params);
    await Promise.all(waiters);
    oldUpload.resolve(response({ file: { file_id: 41 } }));
    await new Promise((resolve) => setImmediate(resolve));
    const joinsRetry = adapter.registerVoice(account, params);
    retryUpload.resolve(response({ file: { file_id: 42 } }));
    const [id, joinedId] = await Promise.all([retry, joinsRetry]);
    expect(joinedId).toBe(id);
    expect(uploads).toBe(2);
    const clones = transport.mock.calls.filter(([url]) => String(url).endsWith('/voice_clone'));
    expect(clones.map(([, init]) => JSON.parse(String(init?.body)).file_id)).toEqual([42]);
  });

  it('preserves the exact int64 file ID from upload when forwarding it to clone', async () => {
    transport
      .mockResolvedValueOnce(
        new Response('{"file":{"file_id":9007199254740993},"base_resp":{"status_code":0}}'),
      )
      .mockResolvedValueOnce(response());
    await adapter.registerVoice(account, {
      voiceId: '讲师',
      referenceAudioBase64: sample().toString('base64'),
    });
    expect(String(transport.mock.calls[1][1]!.body)).toMatch(/"file_id"\s*:\s*9007199254740993\b/);
  });

  it('requires an uploaded file ID before submitting the clone', async () => {
    transport.mockResolvedValueOnce(response({ file: null }));
    await expect(
      adapter.registerVoice(account, {
        voiceId: '讲师',
        referenceAudioBase64: sample().toString('base64'),
      }),
    ).rejects.toThrow(/file[_ ]id/i);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([true, { type: 1 }])(
    'does not return a voice ID for a flagged sample (%j)',
    async (flag) => {
      transport
        .mockResolvedValueOnce(response({ file: { file_id: 42 } }))
        .mockResolvedValueOnce(response({ input_sensitive: flag }));
      await expect(
        adapter.registerVoice(account, {
          voiceId: 'Tutor',
          referenceAudioBase64: sample().toString('base64'),
        }),
      ).rejects.toThrow(/sample/i);
    },
  );

  it('creates separate voice IDs for concurrent managed registrations with identical samples', async () => {
    transport.mockImplementation(async (url) =>
      String(url).endsWith('/files/upload') ? response({ file: { file_id: 42 } }) : response(),
    );
    const cfg = { ...account, managed: true };
    const params = { voiceId: '讲师', referenceAudioBase64: sample().toString('base64') };
    const [a, b] = await Promise.all([
      adapter.registerVoice(cfg, params),
      adapter.registerVoice(cfg, params),
    ]);
    expect(a).not.toBe(b);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it.each([
    [9, 24_000],
    [61, 24_000],
    [10, 16_000],
  ])('rejects %ss at %s Hz before uploading', async (seconds, sampleRate) => {
    await expect(
      adapter.registerVoice(account, {
        voiceId: 'teacher',
        referenceAudioBase64: sample(seconds, sampleRate).toString('base64'),
      }),
    ).rejects.toThrow(/24 kHz mono PCM WAV.*10.*60/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('surfaces an upload failure and an ID collision without returning or reusing a voice', async () => {
    const params = { voiceId: 'female-yujie', referenceAudioBase64: sample().toString('base64') };
    transport.mockResolvedValueOnce(
      response({
        file: { file_id: 987 },
        base_resp: { status_code: 1004, status_msg: 'auth failed' },
      }),
    );
    await expect(adapter.registerVoice(account, params)).rejects.toThrow(/1004/);
    expect(transport).toHaveBeenCalledTimes(1);
    transport
      .mockResolvedValueOnce(response({ file: { file_id: 987 } }))
      .mockResolvedValueOnce(
        response({ base_resp: { status_code: 2039, status_msg: 'duplicate' } }),
      );
    await expect(adapter.registerVoice(account, params)).rejects.toThrow(/2039/);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each([{ status_code: '1002', status_msg: 'rate limit' }, null])(
    'rejects a failed or malformed business status even alongside voice data',
    async (status) => {
      transport.mockResolvedValueOnce(response({ system_voice: [], base_resp: status }));
      await expect(adapter.listVoices!(account)).rejects.toThrow(status ? /1002/ : /response/i);
    },
  );

  it('explains MiniMax account verification failures without exposing arbitrary gateway output', async () => {
    transport.mockResolvedValueOnce(response({ file: { file_id: 42 } })).mockResolvedValueOnce(
      response({
        base_resp: { status_code: 2038, status_msg: 'test-private-account-detail' },
      }),
    );
    const promise = adapter.registerVoice(account, {
      voiceId: 'Tutor',
      referenceAudioBase64: sample().toString('base64'),
    });
    await expect(promise).rejects.toThrow(/2038.*verif/i);
    await expect(promise).rejects.not.toThrow(/test-private-account-detail/);
  });

  it.each([
    ['clone', 'voice_cloning'],
    ['designed', 'voice_generation'],
  ] as const)('deletes a %s voice using its MiniMax category', async (kind, voiceType) => {
    transport.mockResolvedValueOnce(response({ voice_id: 'voice-2026' }));
    await adapter.deleteVoice!(account, 'voice-2026', undefined, kind);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe('https://gateway.example/minimax/v1/delete_voice');
    expect(JSON.parse(String(init!.body))).toEqual({
      voice_type: voiceType,
      voice_id: 'voice-2026',
    });
  });

  it('requires the voice category before deleting and reports provider refusal', async () => {
    await expect(adapter.deleteVoice!(account, 'female-yujie')).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValueOnce(
      response({ base_resp: { status_code: 2042, status_msg: 'forbidden' } }),
    );
    await expect(
      adapter.deleteVoice!(account, 'other-account', undefined, 'clone'),
    ).rejects.toThrow(/2042/);
  });

  it('uses the public network policy for a personal endpoint', async () => {
    await expect(adapter.listVoices!({ ...account, baseUrl: 'http://127.0.0.1' })).rejects.toThrow(
      /Local\/private network/,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('synthesizes the registered ID on the same versioned regional gateway', async () => {
    const cfg = { ...account, baseUrl: 'https://regional.example/gateway/v1/?GroupId=42' };
    transport
      .mockResolvedValueOnce(response({ file: { file_id: 42 } }))
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({ data: { audio: '1234' } }));
    const voiceId = await adapter.registerVoice(cfg, {
      voiceId: 'Tutor',
      referenceAudioBase64: sample().toString('base64'),
    });
    await generateTTS({ ...cfg, providerId: 'minimax-tts', voice: voiceId }, 'A test');
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
      'https://regional.example/gateway/v1/files/upload?GroupId=42',
      'https://regional.example/gateway/v1/voice_clone?GroupId=42',
      'https://regional.example/gateway/v1/t2a_v2?GroupId=42',
    ]);
    expect(JSON.parse(String(transport.mock.calls[2][1]?.body)).voice_setting.voice_id).toBe(
      voiceId,
    );
  });
});
