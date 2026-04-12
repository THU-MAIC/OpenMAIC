import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/ai/llm', () => ({
  callLLM: vi.fn().mockResolvedValue({ text: 'A diagram showing React components' }),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromHeaders: vi.fn().mockResolvedValue({
    model: {},
    modelInfo: {},
    modelString: 'test-model',
  }),
}));

describe('POST /api/generate/media-prompt', () => {
  it('returns a generated prompt string', async () => {
    const { POST } = await import('@/app/api/generate/media-prompt/route');
    const req = new Request('http://localhost/api/generate/media-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-model': 'test-model' },
      body: JSON.stringify({
        indicationText: 'React components: props, state, re-render',
        mediaType: 'image',
        language: 'en-US',
      }),
    });
    const res = await POST(req as never);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(typeof data.data.prompt).toBe('string');
    expect(data.data.prompt.length).toBeGreaterThan(0);
  });

  it('returns 400 when indicationText is missing', async () => {
    const { POST } = await import('@/app/api/generate/media-prompt/route');
    const req = new Request('http://localhost/api/generate/media-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaType: 'image' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});
