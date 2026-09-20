// TDD RED: POST /api/generate/clarify — the pre-outline ask_user preflight.
import { beforeEach, describe, expect, test, vi } from 'vitest';

const callLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  callLLM: callLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: async () => body,
    headers: {
      get: () => null,
    },
    signal: undefined,
  };
}

describe('POST /api/generate/clarify', () => {
  beforeEach(() => {
    callLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'test', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:test-model',
      providerId: 'test',
      modelId: 'test-model',
      thinkingConfig: undefined,
    });
  });

  test('returns questions when the model asks for clarification', async () => {
    vi.resetModules();
    const { POST } = await import('@/app/api/generate/clarify/route');
    callLLMMock.mockResolvedValue({
      text: JSON.stringify({
        needsClarification: true,
        questions: [
          {
            id: 'q1',
            question: 'Who is this course for?',
            options: [{ id: 'kids', label: 'Kids' }],
            allowFreeText: true,
          },
        ],
      }),
    });

    const response = await POST(
      mockRequest({
        requirements: { requirement: 'Teach photosynthesis' },
        researchContext: '',
      }) as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.needsClarification).toBe(true);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]).toMatchObject({ id: 'q1', question: 'Who is this course for?' });
  });

  test('returns needsClarification false when the request is unambiguous', async () => {
    vi.resetModules();
    const { POST } = await import('@/app/api/generate/clarify/route');
    callLLMMock.mockResolvedValue({
      text: JSON.stringify({ needsClarification: false, questions: [] }),
    });

    const response = await POST(
      mockRequest({ requirements: { requirement: 'Teach photosynthesis to kids' } }) as never,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ needsClarification: false, questions: [] });
  });

  test('fails open to no-clarification when the model output is unparseable', async () => {
    vi.resetModules();
    const { POST } = await import('@/app/api/generate/clarify/route');
    callLLMMock.mockResolvedValue({ text: 'garbage {{{' });

    const response = await POST(
      mockRequest({ requirements: { requirement: 'Teach photosynthesis' } }) as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ needsClarification: false, questions: [] });
  });

  test('rejects requests without requirements', async () => {
    vi.resetModules();
    const { POST } = await import('@/app/api/generate/clarify/route');

    const response = await POST(mockRequest({}) as never);

    expect(response.status).toBe(400);
  });
});
