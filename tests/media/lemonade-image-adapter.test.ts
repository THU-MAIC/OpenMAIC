import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  generateWithLemonadeImage,
  testLemonadeImageConnectivity,
} from '@/lib/media/adapters/lemonade-image-adapter';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

describe('lemonade-image-adapter', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts generation requests to /images/generations with b64_json response_format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'aW1n' }] }),
    });

    const result = await generateWithLemonadeImage(
      { providerId: 'lemonade', apiKey: '', baseUrl: 'http://localhost:13305/v1/' },
      { prompt: 'a fox', width: 768, height: 768 },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:13305/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      model: 'Qwen-Image-GGUF',
      prompt: 'a fox',
      n: 1,
      size: '768x768',
      response_format: 'b64_json',
    });
    expect(result).toEqual({
      url: undefined,
      base64: 'aW1n',
      width: 768,
      height: 768,
    });
  });

  it('falls back to default base URL and 1024x1024 when not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'eA==' }] }),
    });

    await generateWithLemonadeImage({ providerId: 'lemonade', apiKey: '' }, { prompt: 'tile' });

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:13305/v1/images/generations');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.size).toBe('1024x1024');
  });

  it('forwards custom model id when provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'eA==' }] }),
    });

    await generateWithLemonadeImage(
      { providerId: 'lemonade', apiKey: '', model: 'flux-schnell' },
      { prompt: 'p' },
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('flux-schnell');
  });

  it('attaches Bearer auth header when apiKey is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'eA==' }] }),
    });

    await generateWithLemonadeImage({ providerId: 'lemonade', apiKey: 'sk-lm' }, { prompt: 'p' });

    expect(mockFetch.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-lm',
    });
  });

  it('omits auth header when apiKey is empty (keyless)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ b64_json: 'eA==' }] }),
    });

    await generateWithLemonadeImage({ providerId: 'lemonade', apiKey: '' }, { prompt: 'p' });

    expect(mockFetch.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('throws a useful error on failed generation responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'model unavailable',
      statusText: 'Internal Server Error',
    });

    await expect(
      generateWithLemonadeImage({ providerId: 'lemonade', apiKey: '' }, { prompt: 'p' }),
    ).rejects.toThrow('Lemonade image generation failed (500): model unavailable');
  });

  it('throws when response payload contains no image data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{}] }),
    });

    await expect(
      generateWithLemonadeImage({ providerId: 'lemonade', apiKey: '' }, { prompt: 'p' }),
    ).rejects.toThrow('Lemonade returned empty image response');
  });

  it('reports connectivity success against /models endpoint', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await testLemonadeImageConnectivity({ providerId: 'lemonade', apiKey: '' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:13305/v1/models',
      expect.objectContaining({ headers: {} }),
    );
    expect(result.success).toBe(true);
  });

  it('reports connectivity failure with response text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
      statusText: 'Service Unavailable',
    });

    const result = await testLemonadeImageConnectivity({ providerId: 'lemonade', apiKey: '' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Lemonade API error (503): unavailable');
  });
});
