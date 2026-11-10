import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { FoldedWhiteboardRuntimeState } from '@/lib/whiteboard/runtime/types';
import type { WhiteboardRuntimeService } from '@/lib/whiteboard/runtime/store';
import type { StatelessChatRequest } from '@/lib/types/chat';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), asset: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: mocks.fetch }));
vi.mock('@/lib/persistence/resolve-server-asset', () => ({ resolveOwnedAsset: mocks.asset }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: mocks.warn }) }));
import { createWhiteboardPreview } from '@/lib/chat/pi/whiteboard-preview';
import { createChildTailStateTransform } from '@/lib/chat/pi/child-tail-state';
import { createDirectorTailStateTransform } from '@/lib/chat/pi/director-tail-state';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
  'base64',
);
const empty: FoldedWhiteboardRuntimeState = { sessionId: null, lastSeq: null, whiteboard: null };
function state(
  lastSeq = 0,
  sessionId = 'session',
  boardId = 'board',
): FoldedWhiteboardRuntimeState {
  return {
    sessionId,
    lastSeq,
    whiteboard: {
      id: boardId,
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [
        {
          id: 'label',
          type: 'text',
          left: 20,
          top: 20,
          width: 150,
          height: 30,
          rotate: 0,
          content: `<p>Sequence ${lastSeq}</p>`,
          defaultFontName: 'Arial',
          defaultColor: '#000',
        },
      ],
    },
  } as FoldedWhiteboardRuntimeState;
}
const body = {
  storeState: { scenes: [], whiteboardOpen: false },
} as unknown as StatelessChatRequest;
const service = (read: ReturnType<typeof vi.fn>) =>
  ({ read }) as unknown as WhiteboardRuntimeService;
const tailContent = (messages: AgentMessage[]) => {
  const tail = messages.at(-1);
  if (tail?.role !== 'user') throw new Error('Expected a user tail');
  return tail.content;
};
const tailText = (messages: AgentMessage[]) => {
  const content = tailContent(messages);
  return typeof content === 'string' ? content : JSON.stringify(content);
};
function stalledFetch() {
  mocks.fetch.mockImplementation(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

beforeEach(() => {
  vi.stubEnv('RENDER_SERVICE_URL', 'http://render.test/');
  mocks.fetch.mockReset().mockImplementation(async () => new Response(png));
  mocks.warn.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('request-scoped optional whiteboard preview', () => {
  it('does no work without render configuration or for empty boards', async () => {
    vi.stubEnv('RENDER_SERVICE_URL', '');
    expect(createWhiteboardPreview('owner', 'stage')).toBeUndefined();
    vi.stubEnv('RENDER_SERVICE_URL', 'http://render.test');
    const preview = createWhiteboardPreview('owner', 'stage')!;
    expect(await preview(empty)).toBeUndefined();
    const cleared = state(3);
    cleared.whiteboard!.elements = [];
    expect(await preview(cleared)).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('renders the read snapshot through the public protocol and shares pending/cached renders', async () => {
    const preview = createWhiteboardPreview('owner', 'stage')!;
    const snapshot = state();
    const [a, b] = await Promise.all([preview(snapshot), preview(structuredClone(snapshot))]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      image: { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    });
    expect(await preview(snapshot)).toEqual(a);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe('http://render.test/preview');
    expect(options.headers['x-openmaic-client']).toBe('owner');
    expect(JSON.parse(options.body)).toMatchObject({
      version: 1,
      stage: { id: 'stage' },
      scene: { content: { canvas: { elements: snapshot.whiteboard!.elements } } },
      viewport: { width: 1000, height: 563, deviceScaleFactor: 1 },
    });
    await preview(state(1));
    await preview(state(1, 'another-session'));
    await preview(state(1, 'another-session', 'another-board'));
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    // Only the most recent entry is retained.
    await preview(snapshot);
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
  });

  it.each([503, 200])(
    'stops after failure (%s), never substituting an older image; a new request retries',
    async (status) => {
      const preview = createWhiteboardPreview('owner', 'stage')!;
      expect(await preview(state())).toBeDefined();
      mocks.fetch.mockResolvedValueOnce(new Response('not PNG', { status }));
      expect(await preview(state(1))).toBeUndefined();
      expect(await preview(state())).toBeUndefined();
      expect(await preview(state(2))).toBeUndefined();
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(await createWhiteboardPreview('owner', 'stage')!(state(2))).toBeDefined();
      expect(mocks.fetch).toHaveBeenCalledTimes(3);
    },
  );

  it('shares failure across Director and multiple Children without changing readable text to read_failed', async () => {
    const preview = createWhiteboardPreview('owner', 'stage')!;
    mocks.fetch.mockResolvedValue(new Response('busy', { status: 429 }));
    const read = vi.fn().mockResolvedValue(state());
    const options = { preview, service: service(read), stageId: 'stage' };
    const director = createDirectorTailStateTransform({
      ...options,
      body,
      getAgentResponses: () => [],
      compaction: {
        transformContext: async (m) => m,
        getTrace: () => ({ triggerCount: 0 }) as never,
        dispose() {},
      },
    });
    for (const transform of [
      createChildTailStateTransform(options),
      director,
      createChildTailStateTransform(options),
    ]) {
      const result = await transform([]);
      expect(tailText(result)).toContain('"status":"ok"');
      expect(tailText(result)).not.toContain('read_failed');
      expect(typeof tailContent(result)).toBe('string');
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends no cached image after clear or a failed read', async () => {
    const preview = createWhiteboardPreview('owner', 'stage')!;
    const cleared = state(1);
    cleared.whiteboard!.elements = [];
    const read = vi
      .fn()
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(cleared)
      .mockRejectedValueOnce(new Error('offline'));
    const child = createChildTailStateTransform({
      preview,
      service: service(read),
      stageId: 'stage',
    });
    expect(Array.isArray(tailContent(await child([])))).toBe(true);
    const afterClear = await child([]);
    expect(tailText(afterClear)).toContain('"lastSeq":1');
    expect(typeof tailContent(afterClear)).toBe('string');
    expect(tailText(await child([]))).toContain('read_failed');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches text and image after compaction and budgets the transient image without storing it', async () => {
    let triggers = 0;
    const preview = createWhiteboardPreview('owner', 'stage')!;
    const read = vi.fn().mockResolvedValueOnce(state()).mockResolvedValueOnce(state(1));
    const history: AgentMessage[] = [{ role: 'user', content: 'Question', timestamp: 0 }];
    const before = structuredClone(history);
    const transformContext = vi.fn(
      async (messages: AgentMessage[], _signal?: AbortSignal, tokens?: number) => {
        expect(messages).toEqual(before);
        expect(tokens).toBeGreaterThan(1200);
        triggers++;
        return messages;
      },
    );
    const director = createDirectorTailStateTransform({
      preview,
      service: service(read),
      stageId: 'stage',
      body,
      getAgentResponses: () => [],
      compaction: {
        transformContext,
        getTrace: () => ({ triggerCount: triggers }) as never,
        dispose() {},
      },
    });
    const result = await director(history);
    expect(history).toEqual(before);
    expect(tailText(result)).toContain('Whiteboard image at lastSeq=1;');
    expect(tailText(result)).not.toContain('Sequence 0');
    expect(
      mocks.fetch.mock.calls.map(
        ([, init]) => JSON.parse(init.body).scene.content.canvas.elements[0].content,
      ),
    ).toEqual(['<p>Sequence 0</p>', '<p>Sequence 1</p>']);
    expect(
      estimateTokens({
        role: 'user',
        timestamp: 0,
        content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }],
      }),
    ).toBe(1200);
  });

  it('bounds preview work to five seconds and disables later attempts', async () => {
    vi.useFakeTimers();
    stalledFetch();
    const preview = createWhiteboardPreview('owner', 'stage')!;
    const result = preview(state());
    await vi.advanceTimersByTimeAsync(4999);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'timeout', durationMs: expect.any(Number) }),
    );
    expect(await preview(state(1))).toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates Child cancellation without warning and allows a later caller to render', async () => {
    vi.useFakeTimers();
    stalledFetch();
    const controller = new AbortController();
    const preview = createWhiteboardPreview('owner', 'stage')!;
    const result = preview(state(), controller.signal);
    const rejected = expect(result).rejects.toThrow('Child tool deadline');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('Child tool deadline'));
    await rejected;
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mocks.warn).not.toHaveBeenCalled();
    await expect(preview(state(), controller.signal)).rejects.toThrow('Child tool deadline');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    mocks.fetch.mockResolvedValueOnce(new Response(png));
    const freshSignal = new AbortController().signal;
    const recovered = await preview(state(), freshSignal);
    expect(recovered?.image.data).toBe(png.toString('base64'));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    // The cancelled Promise was discarded; the successful replacement is reusable.
    expect(await preview(state(), freshSignal)).toEqual(recovered);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [new DOMException('https://secret.invalid/token', 'TimeoutError'), 'timeout'],
    [new DOMException('https://secret.invalid/token', 'AbortError'), 'aborted'],
    [new Error('Preview HTTP 503'), 'http_error'],
    [
      Object.assign(new Error('https://secret.invalid/token'), {
        name: 'https://secret.invalid/name',
      }),
      'render_failed',
    ],
  ])('logs only a fixed category and duration', async (error, category) => {
    mocks.fetch.mockRejectedValue(error);
    expect(await createWhiteboardPreview('owner', 'stage')!(state())).toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith({
      event: 'whiteboard_preview_failed',
      category,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('secret.invalid');
  });
});
