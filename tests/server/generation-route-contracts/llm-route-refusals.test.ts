/**
 * Characterization: the answers the LLM generation routes give when the
 * generation cannot be used. They pin each route's status, error code and
 * message, and import nothing but the routes, so they run unchanged against
 * the routes before and after the steps moved into lib/server/generation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  streamLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  generateSceneContent: vi.fn(),
  buildCompleteScene: vi.fn(),
  generateSceneActions: vi.fn(),
  buildPrompt: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM, streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneContent: mocks.generateSceneContent,
  buildCompleteScene: mocks.buildCompleteScene,
  generateSceneActions: mocks.generateSceneActions,
}));
vi.mock('@/lib/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prompts')>()),
  buildPrompt: mocks.buildPrompt,
}));
vi.mock('@/lib/server/generation-capabilities', () => ({
  resolveServerGenerationCapabilities: async () => ({
    webSearch: false,
    imageGeneration: false,
    videoGeneration: false,
    tts: false,
  }),
}));

function post(path: string, body: unknown): NextRequest {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

const outline = {
  id: 'o1',
  order: 1,
  type: 'slide',
  title: 'Leaves',
  description: 'How leaves work',
  keyPoints: [],
};

describe('LLM generation route refusals', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:test-model',
      thinkingConfig: undefined,
      serverManaged: false,
    });
  });

  describe('POST /api/generate/agent-profiles', () => {
    const body = {
      stageInfo: { name: 'Plants' },
      languageDirective: 'Teach in English.',
      availableAvatars: ['/a.png'],
    };
    const teacher = { name: 'T', role: 'teacher', persona: 'p', avatar: '/a.png', color: '#111' };

    it.each([
      [
        'an unparseable answer',
        'not json',
        'PARSE_FAILED',
        'Failed to parse agent profiles from LLM response',
      ],
      [
        'too few agents',
        JSON.stringify({ agents: [teacher] }),
        'GENERATION_FAILED',
        'Expected at least 2 agents but LLM returned 1',
      ],
      [
        'no single teacher',
        JSON.stringify({ agents: [teacher, teacher] }),
        'GENERATION_FAILED',
        'Expected exactly 1 teacher but LLM returned 2',
      ],
    ])('answers %s with 500', async (_case, text, errorCode, error) => {
      mocks.callLLM.mockResolvedValue({ text });
      const { POST } = await import('@/app/api/generate/agent-profiles/route');
      expect(await answer(await POST(post('/api/generate/agent-profiles', body)))).toEqual({
        status: 500,
        body: { success: false, errorCode, error },
      });
    });
  });

  it('POST /api/generate/scene-content answers no content with 500 GENERATION_FAILED', async () => {
    mocks.generateSceneContent.mockResolvedValue(null);
    const { POST } = await import('@/app/api/generate/scene-content/route');
    const response = await POST(
      post('/api/generate/scene-content', {
        outline,
        allOutlines: [outline],
        stageId: 'stage-1',
        stageInfo: { name: 'Plants' },
      }),
    );
    expect(await answer(response)).toEqual({
      status: 500,
      body: {
        success: false,
        errorCode: 'GENERATION_FAILED',
        error: 'Failed to generate content: Leaves',
      },
    });
  });

  it('POST /api/generate/scene-actions answers a failed assembly with 500 GENERATION_FAILED', async () => {
    mocks.generateSceneActions.mockResolvedValue([]);
    mocks.buildCompleteScene.mockReturnValue(null);
    const { POST } = await import('@/app/api/generate/scene-actions/route');
    const response = await POST(
      post('/api/generate/scene-actions', {
        outline,
        allOutlines: [outline],
        content: { elements: [] },
        stageId: 'stage-1',
      }),
    );
    expect(await answer(response)).toEqual({
      status: 500,
      body: {
        success: false,
        errorCode: 'GENERATION_FAILED',
        error: 'Failed to build scene: Leaves',
      },
    });
  });

  it('POST /api/generate/scene-outlines-stream answers a missing template with 500 before streaming', async () => {
    mocks.buildPrompt.mockReturnValue(null);
    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      post('/api/generate/scene-outlines-stream', {
        requirements: { requirement: 'Fractions', interactiveMode: true },
      }),
    );
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await answer(response)).toEqual({
      status: 500,
      body: { success: false, errorCode: 'INTERNAL_ERROR', error: 'Prompt template not found' },
    });
    expect(mocks.streamLLM).not.toHaveBeenCalled();
  });
});
