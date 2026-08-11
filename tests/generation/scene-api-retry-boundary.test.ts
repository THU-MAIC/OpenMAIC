import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';
import { legacyPBLSceneFixture } from '@/tests/fixtures/pbl-v1-scene';

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

vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
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

const pblOutline = {
  id: 'outline-pbl-1',
  type: 'pbl',
  title: legacyPBLSceneFixture.title,
  description: 'Continue a stored legacy PBL project.',
  keyPoints: ['garden measurements'],
  order: 1,
  pblConfig: {
    projectTopic: legacyPBLSceneFixture.title,
    projectDescription: 'Continue a stored legacy PBL project.',
    targetSkills: ['data analysis'],
    issueCount: 2,
  },
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

  it('normalizes stored legacy PBL content before generating actions and building the scene', async () => {
    vi.resetModules();
    mocks.generateSceneActions.mockImplementation(async (_outline, content, aiCall) => {
      await aiCall('system', 'user');
      return 'projectV2' in content
        ? [{ id: 'action-1', type: 'speech', title: 'Welcome', text: 'Let us continue.' }]
        : [];
    });
    mocks.buildCompleteScene.mockImplementation((_outline, content, actions, stageId) => {
      if (!('projectV2' in content)) return null;
      return {
        id: 'scene-pbl-1',
        stageId,
        type: 'pbl',
        title: pblOutline.title,
        order: pblOutline.order,
        content: { type: 'pbl', projectV2: content.projectV2 },
        actions,
      };
    });

    const { POST } = await import('@/app/api/generate/scene-actions/route');
    const response = await POST(
      mockRequest({
        outline: pblOutline,
        allOutlines: [pblOutline],
        content: structuredClone(legacyPBLSceneFixture.content),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scene.actions).toHaveLength(1);
    expect(mocks.generateSceneActions.mock.calls[0][1]).toMatchObject({
      type: 'pbl',
      projectV2: { title: legacyPBLSceneFixture.title },
    });
    expect(mocks.buildCompleteScene.mock.calls[0][1]).toBe(
      mocks.generateSceneActions.mock.calls[0][1],
    );
  });

  it('builds damaged hybrid PBL content from the upgraded legacy project', async () => {
    vi.resetModules();
    mocks.generateSceneActions.mockResolvedValue([
      { id: 'action-1', type: 'speech', title: 'Welcome', text: 'Let us continue.' },
    ]);
    mocks.buildCompleteScene.mockImplementation((_outline, content, actions, stageId) => {
      if (!('projectV2' in content)) return null;
      return {
        id: 'scene-pbl-1',
        stageId,
        type: 'pbl',
        title: pblOutline.title,
        order: pblOutline.order,
        content: { type: 'pbl', projectV2: content.projectV2 },
        actions,
      };
    });
    const damagedHybrid = structuredClone(legacyPBLSceneFixture.content);
    Reflect.set(damagedHybrid, 'projectV2', { title: 'broken' });

    const { POST } = await import('@/app/api/generate/scene-actions/route');
    const response = await POST(
      mockRequest({
        outline: pblOutline,
        allOutlines: [pblOutline],
        content: damagedHybrid,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.scene.content.projectV2).toMatchObject({
      title: 'Community Garden Data Project',
      milestones: [{ title: 'Inspect the measurements' }, { title: 'Recommend a watering plan' }],
    });
    expect(body.scene.content.projectV2).not.toEqual({ title: 'broken' });
    expect(mocks.buildCompleteScene.mock.calls[0][1]).toBe(
      mocks.generateSceneActions.mock.calls[0][1],
    );
  });

  it('keeps a title-only legacy shell on the existing empty-content error path', async () => {
    vi.resetModules();
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.buildCompleteScene.mockImplementation((_outline, content) =>
      'projectV2' in content ? { content } : null,
    );
    const legacyContent = structuredClone(legacyPBLSceneFixture.content);
    if (legacyContent.type !== 'pbl' || !legacyContent.projectConfig) {
      throw new Error('expected legacy PBL content');
    }
    const projectConfig = legacyContent.projectConfig;
    projectConfig.agents = [];
    projectConfig.issueboard.issues = [];
    projectConfig.issueboard.current_issue_id = null;
    projectConfig.chat.messages = [];
    projectConfig.selectedRole = null;

    const { POST } = await import('@/app/api/generate/scene-actions/route');
    const response = await POST(
      mockRequest({
        outline: pblOutline,
        allOutlines: [pblOutline],
        content: { type: 'pbl', projectConfig },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      success: false,
      error: 'Failed to build scene: Community Garden Data Project',
    });
    expect(mocks.generateSceneActions.mock.calls[0][1]).toEqual({ type: 'pbl', projectConfig });
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

  it('preserves the provider status carried by a PBLGenerationError', async () => {
    vi.resetModules();
    const providerError = Object.assign(new Error('provider rate limited'), { statusCode: 429 });
    const { PBLGenerationError } = await import('@openmaic/generation');
    mocks.generateSceneContent.mockRejectedValueOnce(
      new PBLGenerationError('PBL planners failed', {
        cause: providerError,
        statusCode: 429,
      }),
    );

    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(mockRequest({ outline: pblOutline, allOutlines: [pblOutline] }));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body).toMatchObject({
      success: false,
      errorCode: 'RATE_LIMITED',
      error: 'Upstream rate limit reached. Please try again shortly.',
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
