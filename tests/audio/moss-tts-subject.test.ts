import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getMossTtsConcurrency } from '@/lib/server/narration-concurrency';
import { adapterOptions } from '@/lib/server/model-config/adapter-options';
import { generateTTS } from '@/lib/audio/tts-providers';
import { mossCourseSubject, mossSubjectParam } from '@/lib/audio/moss-tts';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);
// Provider adapters issue requests through undici's fetch.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});
vi.mock('@/lib/server/usage-storage', () => ({ recordGenerationUsage: vi.fn() }));

function wavResponse() {
  const data = new Uint8Array(16);
  data.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  data.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'audio/wav' },
    arrayBuffer: async () => data.buffer,
  };
}

function sentBody(): Record<string, unknown> {
  const init = mockFetch.mock.calls.at(-1)?.[1] as { body: string };
  return JSON.parse(init.body);
}

const mossConfig = {
  providerId: 'openai-tts' as const,
  modelId: 'my-hosted-api-model',
  providerOptions: { backend: 'moss' },
  apiKey: 'server-key',
  baseUrl: 'https://moss.example.com/v1/',
  managed: true,
  voice: 'course-narrator',
};

describe('MOSS narration subject', () => {
  beforeEach(() => {
    mockFetch.mockReset().mockResolvedValue(wavResponse());
  });

  it('sends `subject` next to `input` for managed MOSS', async () => {
    await generateTTS({ ...mossConfig, subject: ' 语文 ', previousTexts: ['上一句'] }, '拼音');
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://moss.example.com/v1/audio/speech');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer server-key');
    expect(sentBody()).toMatchObject({
      model: 'my-hosted-api-model',
      voice: 'course-narrator',
      input: '拼音',
      subject: '语文',
      previous_texts: ['上一句'],
    });
  });

  it('downloads a same-origin signed audio link without forwarding the API credential', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ audioUrl: 'https://moss.example.com/audio/result.wav' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const audio = await generateTTS(mossConfig, '测试');
    expect(audio.format).toBe('wav');
    const [url, init] = mockFetch.mock.calls[1];
    expect(String(url)).toBe('https://moss.example.com/audio/result.wav');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('refuses an audio link outside the configured API origin', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ audioUrl: 'https://other.example/result.wav' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(generateTTS(mossConfig, '测试')).rejects.toThrow('invalid audio URL');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('omits an empty subject for managed MOSS', async () => {
    await generateTTS({ ...mossConfig, subject: '   ' }, '拼音');
    expect(sentBody()).not.toHaveProperty('subject');
    await generateTTS(mossConfig, '拼音');
    expect(sentBody()).not.toHaveProperty('subject');
  });

  it.each([
    ['an unmanaged MOSS-named endpoint', { ...mossConfig, managed: false }],
    [
      'a plain compatible API even with a MOSS-like model name',
      { ...mossConfig, modelId: 'moss-tts', providerOptions: {} },
    ],
    [
      'a client requesting the MOSS extensions',
      {
        ...mossConfig,
        providerOptions: adapterOptions(
          { providerId: 'openai-tts', origin: 'configuration' },
          { backend: 'moss' },
        ),
      },
    ],
  ])('never sends `subject` to %s', async (_label, config) => {
    await generateTTS({ ...config, subject: '语文' }, 'Hello');
    expect(sentBody()).not.toHaveProperty('subject');
  });
});

describe('MOSS subject helpers', () => {
  it('prefers the course subject and falls back to the course name', () => {
    expect(mossCourseSubject({ subject: '英语', name: 'Phonics' })).toBe('英语');
    expect(mossCourseSubject({ subject: '  ', name: ' 拼音入门 ' })).toBe('拼音入门');
    expect(mossCourseSubject({ name: 'x'.repeat(300) })).toHaveLength(200);
    expect(mossCourseSubject({ name: '' })).toBeUndefined();
    expect(mossCourseSubject(null)).toBeUndefined();
  });

  it('accepts only a trimmed non-empty request subject of at most 200 chars', () => {
    expect(mossSubjectParam(' 数学 ')).toBe('数学');
    expect(mossSubjectParam('x'.repeat(200))).toHaveLength(200);
    expect(mossSubjectParam('x'.repeat(201))).toBeUndefined();
    expect(mossSubjectParam('   ')).toBeUndefined();
    expect(mossSubjectParam(['语文'])).toBeUndefined();
  });
});

it('shares the operator ceiling across concurrent requests and cancels a queued clip', async () => {
  vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', '2');
  vi.stubEnv('MOSS_TTS_CONCURRENCY', '16');
  const release = Promise.withResolvers<void>();
  mockFetch.mockReset().mockImplementation(async () => {
    await release.promise;
    return wavResponse();
  });
  const controller = new AbortController();
  const queued = Array.from({ length: 6 }, (_, i) =>
    generateTTS(
      {
        ...mossConfig,
        ...(i === 5 ? { signal: controller.signal } : {}),
      },
      'course line ' + i,
    ),
  );
  const settled = Promise.allSettled(queued);
  try {
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(queued[5]).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    await settled;
    vi.unstubAllEnvs();
  }
  expect(mockFetch).toHaveBeenCalledTimes(5);
});

it('respects the explicit serial setting and caps a dedicated deployment at 16', () => {
  try {
    vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', '0');
    vi.stubEnv('MOSS_TTS_CONCURRENCY', '32');
    expect(getMossTtsConcurrency()).toBe(1);
    vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', undefined);
    expect(getMossTtsConcurrency()).toBe(16);
    vi.stubEnv('MOSS_TTS_CONCURRENCY', undefined);
    expect(getMossTtsConcurrency(4)).toBe(4);
    expect(getMossTtsConcurrency(0)).toBe(1);
  } finally {
    vi.unstubAllEnvs();
  }
});
