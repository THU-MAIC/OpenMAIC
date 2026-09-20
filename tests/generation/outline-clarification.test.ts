// TDD RED: the outline stream threads answered clarifications into its prompt.
import { describe, expect, test, vi } from 'vitest';

const streamLLMMock = vi.hoisted(() => vi.fn());
const resolveModelFromRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: streamLLMMock,
}));

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: resolveModelFromRequestMock,
}));

async function readStreamBody(response: Response) {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let text = '';

  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  return text;
}

function parseSseEvents(text: string) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

function mockRequest(body: Record<string, unknown>) {
  return {
    json: async () => body,
    headers: {
      get: () => null,
    },
  };
}

const OUTLINE_RESPONSE = JSON.stringify({
  languageDirective: 'Teach in English.',
  courseTitle: 'Photosynthesis Basics',
  outlines: [
    {
      id: 'scene_1',
      type: 'slide',
      title: 'Photosynthesis',
      description: 'How plants make food',
      keyPoints: ['light'],
      order: 1,
    },
  ],
});

describe('outline stream clarification threading', () => {
  test('injects clarificationQA into the outline prompt as authoritative context', async () => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'test', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:test-model',
      providerId: 'test',
      modelId: 'test-model',
      thinkingConfig: undefined,
    });
    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield OUTLINE_RESPONSE;
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      mockRequest({
        requirements: { requirement: 'Teach photosynthesis' },
        clarificationQA: [{ question: 'Who is this course for?', answer: 'Kids' }],
      }) as never,
    );

    const promptParams = streamLLMMock.mock.calls[0][0] as { system: string; prompt: string };
    expect(promptParams.prompt).toContain('User Clarifications');
    expect(promptParams.prompt).toContain('A1: Kids');

    const events = parseSseEvents(await readStreamBody(response));
    expect(events.find((event) => event.type === 'done')).toBeDefined();
  });

  test('omits the clarifications block when no answers are provided', async () => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelFromRequestMock.mockReset();
    resolveModelFromRequestMock.mockResolvedValue({
      model: { provider: 'test', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:test-model',
      providerId: 'test',
      modelId: 'test-model',
      thinkingConfig: undefined,
    });
    streamLLMMock.mockReturnValue({
      textStream: (async function* () {
        yield OUTLINE_RESPONSE;
      })(),
    });

    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    await POST(mockRequest({ requirements: { requirement: 'Teach photosynthesis' } }) as never);

    const promptParams = streamLLMMock.mock.calls[0][0] as { system: string; prompt: string };
    expect(promptParams.prompt).not.toContain('User Clarifications');
  });
});
