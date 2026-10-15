import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/audio/constants', () => ({ DEFAULT_TTS_VOICES: { 'openai-tts': 'alloy' } }));
vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => true,
  resolveTTSModel: () => 'noiz-operator-pin',
}));
const secret = 'mock_machine_secret_01234567890123456789';
const endpoint = 'http://127.0.0.1:18888/internal/classroom-tts';
function audio() {
  const b = new Uint8Array(1400);
  b.set([255, 243, 132, 196]);
  return b;
}
function request(body: unknown, token = secret, signal?: AbortSignal) {
  return new Request('http://127.0.0.1:13010/api/access-code/codemate-tts/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('CODEMATE_OPENMAIC_TTS_SECRET', secret);
  vi.stubEnv('NOIZ_VOICE_ID', 'server-legacy-uuid');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('AIOJ parent TTS transport', () => {
  test('same native endpoint forwards the complete reviewed text only to the fixed authenticated backend bridge', async () => {
    const fetch = vi.fn(
      async () => new Response(audio(), { headers: { 'Content-Type': 'audio/mpeg' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const { POST } = await import('@/app/api/access-code/codemate-tts/audio/speech/route');
    const text = '原旁白\n代码 i <= n。题目尾部  ';
    const response = await POST(
      request({ input: text, model: 'noiz-operator-pin', voice: 'alloy', speed: 1 }),
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio());
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(JSON.parse(init.body as string)).toEqual({ text, markdown: false });
    const headers = new Headers(init.headers);
    expect(headers.get('x-aioj-classroom-tts-token')).toBe(secret);
    expect(headers.get('x-aioj-tts-deadline')).toMatch(/^\d{13}$/);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Cookie')).toBeNull();
    expect(headers.get('Origin')).toBe('http://127.0.0.1:18888');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  test('supports the server legacy voice identity without forwarding any voice/provider choice', async () => {
    const fetch = vi.fn(
      async () => new Response(audio(), { headers: { 'Content-Type': 'audio/mpeg' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const { POST } = await import('@/app/api/access-code/codemate-tts/audio/speech/route');
    expect((await POST(request({ input: '旁白', voice: 'server-legacy-uuid' }))).status).toBe(200);
    expect(
      JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({ text: '旁白', markdown: false });
  });
  test('missing credentials and client supplier/URL/model/voice overrides never reach the backend', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { POST } = await import('@/app/api/access-code/codemate-tts/audio/speech/route');
    expect((await POST(request({ input: '旁白' }, 'wrong'))).status).toBe(401);
    for (const body of [
      { input: '旁白', provider: 'qwen' },
      { input: '旁白', url: 'https://private.invalid' },
      { input: '旁白', baseUrl: 'http://internal.invalid' },
      { input: '旁白', model: 'client-model' },
      { input: '旁白', voice: 'client-voice' },
      { input: '旁白', response_format: 'wav' },
    ])
      expect((await POST(request(body))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  test('upstream errors and fake audio fail safely without a Noiz fallback or raw error disclosure', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{"error":"secret-value private-url"}', {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const { POST } = await import('@/app/api/access-code/codemate-tts/audio/speech/route');
    const response = await POST(request({ input: '旁白' }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret-value');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(
      new Response('{"error":"not-mp3"}', { headers: { 'Content-Type': 'audio/mpeg' } }),
    );
    expect((await POST(request({ input: '旁白' }))).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('caller cancellation reaches the in-flight real bridge signal and does not publish audio', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetch = vi.fn((_url: RequestInfo | URL, init: RequestInit) => {
      seen = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) =>
        seen?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {
          once: true,
        }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const { POST } = await import('@/app/api/access-code/codemate-tts/audio/speech/route');
    const result = POST(request({ input: '旁白' }, secret, controller.signal));
    await vi.waitFor(() => expect(seen).toBeDefined());
    controller.abort();
    expect((await result).status).toBe(504);
    expect(seen?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('abort while reading the backend response body stops the same deadline-bound transport', async () => {
    const controller = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                streamController = c;
              },
            }),
            { headers: { 'Content-Type': 'audio/mpeg' } },
          ),
      ),
    );
    const { POST } = await import('@/app/api/access-code/codemate-tts/audio/speech/route');
    const result = POST(request({ input: '旁白' }, secret, controller.signal));
    await vi.waitFor(() => expect(streamController).toBeDefined());
    controller.abort();
    expect((await result).status).toBe(504);
  });
});
