import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  applyOutlineFallbacks: vi.fn(),
  generateSceneContent: vi.fn(),
  generateSceneActions: vi.fn(),
  buildCompleteScene: vi.fn(),
  buildVisionUserContent: vi.fn(),
  resolveVocationalActive: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: mocks.callLLM,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

vi.mock('@/lib/config/feature-flags', () => ({
  resolveVocationalActive: mocks.resolveVocationalActive,
}));

vi.mock('@/lib/generation/generation-pipeline', () => ({
  applyOutlineFallbacks: mocks.applyOutlineFallbacks,
  generateSceneContent: mocks.generateSceneContent,
  generateSceneActions: mocks.generateSceneActions,
  buildCompleteScene: mocks.buildCompleteScene,
  buildVisionUserContent: mocks.buildVisionUserContent,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: 'Retry Boundary',
  description: 'Keep retries controlled by the outer scene retry helper.',
  keyPoints: ['no retry multiplication'],
  order: 1,
} as SceneOutline;

describe('scene API retry boundary', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: { id: 'language-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:model',
      thinkingConfig: undefined,
    });
    mocks.applyOutlineFallbacks.mockImplementation((value) => value);
    mocks.callLLM.mockResolvedValue({ text: 'ok' });
    mocks.resolveVocationalActive.mockReturnValue(false);
  });

  it('disables AI SDK retries for scene-content model calls', async () => {
    vi.resetModules();
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return { elements: [], remark: 'ok' };
    });

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest());
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(mocks.callLLM.mock.calls[0][0].maxRetries).toBe(0);
  });

  it('disables AI SDK retries for scene-actions model calls', async () => {
    vi.resetModules();
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
      await aiCall('system', 'user');
      return [];
    });
    mocks.buildCompleteScene.mockReturnValue({
      id: 'scene-1',
      type: 'slide',
      title: outline.title,
      order: outline.order,
      content: { elements: [], remark: 'ok' },
      actions: [],
    });

    const { POST } = await import('@/app/api/generate/scene-actions/route');
    const response = await POST(
      mockRequest({
        content: { elements: [], remark: 'ok' },
      }),
    );
    const body = await response.json();

    expect(body.success).toBe(true);
    expect(mocks.callLLM.mock.calls[0][0].maxRetries).toBe(0);
  });

  it('preserves an upstream 401 from the scene-content route', async () => {
    vi.resetModules();
    const unauthorized = Object.assign(new Error('provider key rejected'), { statusCode: 401 });
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return { elements: [], remark: 'ok' };
    });
    mocks.callLLM.mockRejectedValueOnce(unauthorized);

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'Upstream authentication or authorization failed.',
    });
  });

  it('preserves an upstream 503 from the scene-content route', async () => {
    vi.resetModules();
    const unavailable = Object.assign(new Error('provider overloaded'), { statusCode: 503 });
    mocks.generateSceneContent.mockImplementation(async (_outline, aiCall) => {
      await aiCall('system', 'user');
      return { elements: [], remark: 'ok' };
    });
    mocks.callLLM.mockRejectedValueOnce(unavailable);

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'Upstream model provider is temporarily unavailable. Please try again.',
    });
  });

  it('preserves an upstream 401 from the scene-actions route', async () => {
    vi.resetModules();
    const unauthorized = Object.assign(new Error('provider key rejected'), { statusCode: 401 });
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
      await aiCall('system', 'user');
      return [];
    });
    mocks.callLLM.mockRejectedValueOnce(unauthorized);

    const { POST } = await import('@/app/api/generate/scene-actions/route');
    const response = await POST(mockRequest({ content: { elements: [], remark: 'ok' } }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'Upstream authentication or authorization failed.',
    });
  });

  it('preserves an upstream 503 from the scene-actions route', async () => {
    vi.resetModules();
    const unavailable = Object.assign(new Error('provider overloaded'), { statusCode: 503 });
    mocks.generateSceneActions.mockImplementation(async (_outline, _content, aiCall) => {
      await aiCall('system', 'user');
      return [];
    });
    mocks.callLLM.mockRejectedValueOnce(unavailable);

    const { POST } = await import('@/app/api/generate/scene-actions/route');
    const response = await POST(mockRequest({ content: { elements: [], remark: 'ok' } }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'UPSTREAM_ERROR',
      error: 'Upstream model provider is temporarily unavailable. Please try again.',
    });
  });
});

function mockRequest(extraBody: Record<string, unknown> = {}) {
  return {
    json: async () => ({
      outline,
      allOutlines: [outline],
      stageId: 'stage-1',
      stageInfo: { name: 'Retry Course' },
      ...extraBody,
    }),
  } as unknown as Parameters<typeof import('@/app/api/generate/scene-content/route').POST>[0];
}
