import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock storage backend
vi.mock('@/lib/server/storage', () => ({
  getStorageBackend: () => ({
    loadStage: vi.fn().mockResolvedValue({
      stage: { id: 'stage1', name: 'Test Stage', language: 'en-US' },
    }),
    loadOutlines: vi.fn().mockResolvedValue([
      { id: 'o1', type: 'slide', title: 'Slide 1', description: 'Desc', keyPoints: [], order: 1 },
    ]),
  }),
}));

// Mock generateSceneContentFromInput
vi.mock('@/lib/server/scene-content-generation', () => ({
  generateSceneContentFromInput: vi.fn().mockResolvedValue({
    content: { elements: [{ id: 'el1', type: 'text' }], background: undefined },
    effectiveOutline: { id: 'o1', type: 'slide', title: 'Slide 1', description: 'Desc', keyPoints: [], order: 1 },
    slideTheme: undefined,
  }),
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromHeaders: vi.fn().mockResolvedValue({
    model: {},
    modelInfo: {},
    modelString: 'test-model',
  }),
}));

describe('POST /api/generate/scene-content-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns elements and background for a valid outline', async () => {
    const { POST } = await import('@/app/api/generate/scene-content-only/route');
    const req = new Request('http://localhost/api/generate/scene-content-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-model': 'test-model' },
      body: JSON.stringify({
        outline: { id: 'o1', type: 'slide', title: 'Slide 1', description: 'Desc', keyPoints: [], order: 1 },
        stageId: 'stage1',
      }),
    });
    const res = await POST(req as never);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.elements).toBeDefined();
  });

  it('returns 400 when outline is not a slide', async () => {
    const { POST } = await import('@/app/api/generate/scene-content-only/route');
    const req = new Request('http://localhost/api/generate/scene-content-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outline: { id: 'o1', type: 'quiz', title: 'Quiz 1', description: 'Desc', keyPoints: [], order: 1 },
        stageId: 'stage1',
      }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('returns 400 when outline is missing', async () => {
    const { POST } = await import('@/app/api/generate/scene-content-only/route');
    const req = new Request('http://localhost/api/generate/scene-content-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageId: 'stage1' }),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });
});
