import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTTS, throwIfTtsRateLimited, TTSRateLimitError } from '@/lib/audio/tts-providers';
import { runFailureCode } from '@/lib/server/generation/run/failure-code';
import { withRouteRetry } from '@/lib/server/generation/run/retry';
import { ProviderQuotaExhaustedError } from '@/lib/server/provider-quota';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/audio-provider-fetch', () => ({
  audioProviderFetch: (url: string, init?: RequestInit) => fetchMock(url, init),
  audioEndpointPolicy: () => ({}),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const miniMaxConfig = {
  providerId: 'minimax-tts' as const,
  apiKey: 'test-key',
  baseUrl: 'https://api.minimaxi.com',
  voice: 'female-yujie',
  modelId: 'speech-2.8-hd',
};

describe('throwIfTtsRateLimited', () => {
  it('throws a typed TTSRateLimitError on HTTP 429', () => {
    expect(() => throwIfTtsRateLimited('OpenAI', 429)).toThrow(TTSRateLimitError);
    try {
      throwIfTtsRateLimited('OpenAI', 429);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TTSRateLimitError);
      expect((e as TTSRateLimitError).provider).toBe('OpenAI');
    }
  });

  it('does not throw on non-429 statuses', () => {
    expect(() => throwIfTtsRateLimited('OpenAI', 200)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 401)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 500)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 503)).not.toThrow();
  });
});

describe('TTS provider failure classification', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it.each([1008, 2056, '1008', '2056'])(
    'translates native quota code %s into the provider quota error, not a rate-limit error',
    async (status_code) => {
      fetchMock.mockResolvedValue(
        jsonResponse({ base_resp: { status_code, status_msg: 'Refused' } }),
      );
      const failure = await generateTTS(miniMaxConfig, 'hello').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderQuotaExhaustedError);
      expect(failure).not.toBeInstanceOf(TTSRateLimitError);
      expect(failure).toMatchObject({
        provider: 'MiniMax',
        message: `MiniMax TTS API error (${status_code}): Refused`,
      });
      expect(runFailureCode(failure)).toEqual({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED' });
    },
  );

  it('keeps the rate-limit type on HTTP 429 and carries the quota error as its cause', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ base_resp: { status_code: 2056, status_msg: 'Refused' } }, 429),
    );
    const failure = await generateTTS(miniMaxConfig, 'hello').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TTSRateLimitError);
    expect((failure as Error).cause).toBeInstanceOf(ProviderQuotaExhaustedError);
    expect(runFailureCode(failure)).toEqual({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED' });
  });

  it('translates a quota code in a MiniMax HTTP error body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }, 400),
    );
    const failure = await generateTTS(miniMaxConfig, 'hello').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderQuotaExhaustedError);
    expect((failure as Error).message).toContain('MiniMax TTS API error: ');
    expect(runFailureCode(failure)).toEqual({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED' });
  });

  it.each([
    [200, 1002],
    [429, 1002],
    [400, 1004],
    [500, undefined],
  ])('leaves every other MiniMax answer (%s/%s) as it was', async (status, status_code) => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        status_code === undefined ? { error: 'boom' } : { base_resp: { status_code } },
        status,
      ),
    );
    const failure = await generateTTS(miniMaxConfig, 'hello').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProviderQuotaExhaustedError);
    expect((failure as Error).cause).toBeUndefined();
    expect(runFailureCode(failure)).toEqual({ errorCode: 'INTERNAL_ERROR' });
  });

  it.each([
    ['insufficient_quota', 'PROVIDER_QUOTA_EXHAUSTED'],
    ['rate_limit_exceeded', 'INTERNAL_ERROR'],
  ])(
    'preserves OpenAI %s details without changing its retry delay or error type',
    async (code, errorCode) => {
      fetchMock.mockResolvedValue(
        Response.json(
          { error: { code, message: 'Request refused' } },
          { status: 429, headers: { 'retry-after': '7' } },
        ),
      );
      const failure = await generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'test-key',
          voice: 'alloy',
          modelId: 'tts-1',
        },
        'hello',
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TTSRateLimitError);
      expect(failure).toMatchObject({ retryAfterMs: 7000 });
      expect(runFailureCode(failure)).toEqual({ errorCode });
    },
  );

  it.each([
    [429, 'insufficient_quota'],
    [429, 'rate_limit_exceeded'],
    [403, 'insufficient_quota'],
    [403, 'permission_denied'],
  ])('keeps the existing route retries for OpenAI %s/%s', async (status, code) => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          { error: { code, message: 'Request refused' } },
          { status: status as number },
        ),
      ),
    );
    const sleep = vi.fn(async () => {});
    await expect(
      withRouteRetry(
        () =>
          generateTTS({ providerId: 'openai-tts', apiKey: 'test-key', voice: 'alloy' }, 'hello'),
        { label: 'tts', maxRetries: 1, refusalStatus: 400, sleep },
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws TTSRateLimitError when MiniMax returns HTTP 200 with status_code 1002', async () => {
    // status_msg deliberately does not say "rate limit" or "1002": classification
    // is the numeric code, not the message text.
    fetchMock.mockResolvedValue(
      jsonResponse({
        base_resp: { status_code: 1002, status_msg: 'busy' },
      }),
    );

    try {
      await generateTTS(miniMaxConfig, 'hello');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TTSRateLimitError);
      expect((error as TTSRateLimitError).provider).toBe('MiniMax');
    }
  });

  it('keeps HTTP 429 on the MiniMax endpoint as TTSRateLimitError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'slow down' }, 429));

    await expect(generateTTS(miniMaxConfig, 'hello')).rejects.toBeInstanceOf(TTSRateLimitError);
  });

  it('does not treat other MiniMax status codes as rate limits', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
      }),
    );

    try {
      await generateTTS(miniMaxConfig, 'hello');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TTSRateLimitError);
    }
  });

  it('rejects a numeric-string MiniMax status even when audio bytes are present', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        base_resp: { status_code: '1008', status_msg: 'insufficient balance' },
        data: { audio: '00ff' },
      }),
    );

    await expect(generateTTS(miniMaxConfig, 'hello')).rejects.toThrow(/1008/);
  });

  it('rejects a non-zero MiniMax status even when audio bytes are present', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
        data: { audio: '00ff' },
      }),
    );

    try {
      await generateTTS(miniMaxConfig, 'hello');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TTSRateLimitError);
      expect((error as Error).message).toContain('1008');
    }
  });

  it.each([1002, 1039, 1041, 2045])(
    'classifies MiniMax status_code %s as a rate limit even when audio bytes are present',
    async (statusCode) => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          base_resp: { status_code: statusCode, status_msg: 'slow down' },
          data: { audio: '00ff' },
          extra_info: { audio_format: 'mp3' },
        }),
      );

      try {
        await generateTTS(miniMaxConfig, 'hello');
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TTSRateLimitError);
        expect((error as TTSRateLimitError).provider).toBe('MiniMax');
      }
    },
  );

  it('copies a Retry-After delay onto the MiniMax rate-limit error', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1002, status_msg: 'busy' },
          data: { audio: '00ff' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '7' },
        },
      ),
    );

    try {
      await generateTTS(miniMaxConfig, 'hello');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TTSRateLimitError);
      expect((error as TTSRateLimitError).retryAfterMs).toBe(7000);
    }
  });

  it('copies Retry-After from an HTTP 429 MiniMax response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'slow down' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '3' },
      }),
    );

    try {
      await generateTTS(miniMaxConfig, 'hello');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TTSRateLimitError);
      expect((error as TTSRateLimitError).retryAfterMs).toBe(3000);
    }
  });

  it('returns audio bytes when MiniMax status_code is 0', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { audio: '00ff' },
        extra_info: { audio_format: 'mp3' },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    );

    await expect(generateTTS(miniMaxConfig, 'hello')).resolves.toEqual({
      audio: new Uint8Array([0x00, 0xff]),
      format: 'mp3',
    });
  });
});
