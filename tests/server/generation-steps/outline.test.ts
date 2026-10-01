import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StepAbortedError } from '@/lib/server/generation/steps/context';
import {
  generateOutlines,
  OutlineGenerationError,
  type OutlineEvent,
  type OutlineInput,
} from '@/lib/server/generation/steps/outline';

import { fakeModel, jsonRequest, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  streamLLM: vi.fn(),
  resolveModelFromRequest: vi.fn(),
  capabilities: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/server/generation-capabilities', () => ({
  resolveServerGenerationCapabilities: mocks.capabilities,
}));

const model = fakeModel();

const body: Omit<OutlineInput, 'model'> = {
  requirements: { requirement: 'Teach fractions to ten-year-olds' } as OutlineInput['requirements'],
  pdfText: '',
  pdfImages: [],
  imageMapping: {},
  researchContext: '',
};

const OUTLINE_TEXT = JSON.stringify({
  languageDirective: 'Teach in English.',
  courseTitle: 'Fractions',
  outlines: [
    { id: 'o1', type: 'slide', title: 'Halves', description: 'd', keyPoints: ['a'] },
    { id: 'o2', type: 'quiz', title: 'Check', description: 'd', keyPoints: ['b'] },
  ],
});

/** Each stream call answers the next text in turn (the last one repeats). */
function streams(...texts: string[]) {
  let call = 0;
  mocks.streamLLM.mockImplementation(() => {
    const text = texts[Math.min(call++, texts.length - 1)]!;
    return {
      fullStream: (async function* () {
        // Split the answer so the outlines are parsed incrementally.
        const middle = Math.floor(text.length / 2);
        for (const chunk of [text.slice(0, middle), text.slice(middle)]) {
          if (chunk) yield { type: 'text-delta', text: chunk };
        }
        yield { type: 'finish', finishReason: 'stop' };
      })(),
    };
  });
}

function stepContext(events: OutlineEvent[], signal?: AbortSignal) {
  return {
    log: testLogger(),
    signal,
    emit: (event: OutlineEvent) => events.push(event),
    workspaceId: null,
    resolveVisionImages: async (images: readonly { id: string; src: string }[]) => [...images],
  };
}

async function sseEvents(response: Response) {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

describe('outline step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.streamLLM.mockReset();
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue(model);
    mocks.capabilities.mockReset();
    mocks.capabilities.mockResolvedValue({
      webSearch: false,
      imageGeneration: false,
      videoGeneration: false,
      tts: false,
    });
  });

  it('reports the directive, the title and each outline as the model writes them', async () => {
    streams(OUTLINE_TEXT);
    const events: OutlineEvent[] = [];
    const result = await generateOutlines({ ...body, model }, stepContext(events));

    expect(events.map((event) => event.type)).toEqual([
      'languageDirective',
      'courseTitle',
      'outline',
      'outline',
    ]);
    expect(result).toMatchObject({
      languageDirective: 'Teach in English.',
      courseTitle: 'Fractions',
      taskEngineMode: false,
      outlines: [
        { id: 'o1', order: 1, title: 'Halves' },
        { id: 'o2', order: 2, title: 'Check' },
      ],
    });
    expect(mocks.capabilities).toHaveBeenCalledWith(null);
  });

  it('retries an empty answer, reporting each retry, and then fails with the last error', async () => {
    streams('');
    const events: OutlineEvent[] = [];
    await expect(generateOutlines({ ...body, model }, stepContext(events))).rejects.toThrow(
      new OutlineGenerationError('LLM returned empty response'),
    );
    expect(mocks.streamLLM).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      { type: 'retry', attempt: 1, maxAttempts: 3 },
      { type: 'retry', attempt: 2, maxAttempts: 3 },
    ]);
  });

  it('recovers on a retry after an empty answer', async () => {
    streams('', OUTLINE_TEXT);
    const events: OutlineEvent[] = [];
    const result = await generateOutlines({ ...body, model }, stepContext(events));
    expect(events[0]).toEqual({ type: 'retry', attempt: 1, maxAttempts: 3 });
    expect(result.outlines).toHaveLength(2);
  });

  it('stops without retrying once the caller goes away', async () => {
    const controller = new AbortController();
    controller.abort();
    streams(OUTLINE_TEXT);
    await expect(
      generateOutlines({ ...body, model }, stepContext([], controller.signal)),
    ).rejects.toBeInstanceOf(StepAbortedError);
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
  });

  it('keeps media out of the prompt when the caller opts out, whatever the slots offer', async () => {
    mocks.capabilities.mockResolvedValue({
      webSearch: false,
      imageGeneration: true,
      videoGeneration: true,
      tts: false,
    });
    streams(OUTLINE_TEXT);
    await generateOutlines({ ...body, model }, stepContext([]));
    const offered = (mocks.streamLLM.mock.calls[0]![0] as { system: string }).system;

    mocks.streamLLM.mockClear();
    streams(OUTLINE_TEXT);
    await generateOutlines(
      { ...body, model, allowImageGeneration: false, allowVideoGeneration: false },
      stepContext([]),
    );
    const optedOut = (mocks.streamLLM.mock.calls[0]![0] as { system: string }).system;
    expect(optedOut).not.toEqual(offered);
  });

  it('streams the route exactly the events and result the step produces', async () => {
    streams('', OUTLINE_TEXT);
    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      jsonRequest('http://localhost/api/generate/scene-outlines-stream', body),
    );
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    const routed = await sseEvents(response);

    streams('', OUTLINE_TEXT);
    const events: OutlineEvent[] = [];
    const result = await generateOutlines({ ...body, model }, stepContext(events));
    expect(routed).toEqual([...events, JSON.parse(JSON.stringify({ type: 'done', ...result }))]);
  });

  it('streams the step failure as the route error event', async () => {
    streams('');
    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(
      jsonRequest('http://localhost/api/generate/scene-outlines-stream', body),
    );
    const routed = await sseEvents(response);
    expect(routed.at(-1)).toEqual({ type: 'error', error: 'LLM returned empty response' });
  });
});
