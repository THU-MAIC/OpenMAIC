// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import type { ChatSession, StatelessEvent } from '@/lib/types/chat';

const fixture = vi.hoisted(() => ({
  state: {
    stage: { id: 'sse-park', name: 'SSE regression', createdAt: 1, updatedAt: 1 },
    chats: [] as ChatSession[],
    scenes: [],
    outlines: [],
    currentSceneId: null,
    mode: 'playback',
    setChats(chats: ChatSession[]) {
      this.chats = chats;
    },
  },
  capabilities: vi.fn(),
}));
// Only peripheral stores/config and visual children are substituted. The real
// ChatArea, session hook, Pi SSE reader and paced StreamBuffer run together.
vi.mock('@/lib/store', () => ({
  useStageStore: Object.assign(
    (select: (state: typeof fixture.state) => unknown) => select(fixture.state),
    { getState: () => fixture.state },
  ),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/model-settings/capabilities', () => ({
  loadModelCapabilities: fixture.capabilities,
  classroomChatUsable: () => true,
}));
vi.mock('@/components/chat/session-list', () => ({ SessionList: () => null }));
vi.mock('@/components/chat/lecture-notes-view', () => ({ LectureNotesView: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('allows a follow-up after an empty SSE turn marks the session as an error', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  fixture.state.stage.id = 'sse-error-retry';
  fixture.state.chats = [];
  fixture.capabilities.mockReset().mockResolvedValue({});
  const requests: Array<{ messages: ChatSession['messages'] }> = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response('data: {"type":"done","data":{"totalActions":0,"totalAgents":0}}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const root = createRoot(document.createElement('div'));
  const ref = createRef<ChatAreaRef>();
  try {
    await act(async () => root.render(createElement(ChatArea, { ref })));
    let first!: Promise<void>;
    await act(async () => {
      first = ref.current!.sendMessage('Explain');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      await first;
    });
    expect(requests).toHaveLength(1);
    expect(fixture.state.chats[0]?.status).toBe('error');

    let followUp!: Promise<void>;
    await act(async () => {
      followUp = ref.current!.sendMessage('And now?');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
      await followUp;
    });
    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages.filter(
        (message) =>
          message.role === 'user' &&
          message.parts.some((part) => part.type === 'text' && part.text === 'And now?'),
      ),
    ).toHaveLength(1);
  } finally {
    act(() => root.unmount());
  }
});

it.each([
  'abort-aware',
  'late-eof',
  'cue-before-buffer-done',
  'stop-during-preparation',
  'unmount-during-preparation',
  'stage-switch-during-preparation',
] as const)(
  'consumes the park before async send and cannot restore it while retiring done-before-EOF (%s)',
  async (retirement) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    fixture.state.stage.id = 'sse-park';
    fixture.state.chats = [];
    fixture.capabilities.mockReset().mockResolvedValue({});
    const requests: Array<{ messages: ChatSession['messages']; directorState?: unknown }> = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    let deferredDone: StatelessEvent | undefined;
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
          if (requests.length !== 1 || retirement !== 'late-eof') {
            init.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            );
          }
          if (requests.length !== 1) return;
          const events: StatelessEvent[] = [
            {
              type: 'agent_start',
              data: { messageId: 'question', agentId: 'default-1', agentName: 'Teacher' },
            },
            { type: 'text_delta', data: { messageId: 'question', content: 'What now?' } },
            { type: 'agent_end', data: { messageId: 'question', agentId: 'default-1' } },
            {
              type: 'cue_user',
              data: { prompt: 'What now?', options: ['Practice', 'Another example'] },
            },
            {
              type: 'done',
              data: {
                totalActions: 0,
                totalAgents: 1,
                agentHadContent: true,
                cueUserReceived: true,
                directorState: { turnCount: 1, agentResponses: [], whiteboardLedger: [] },
              },
            },
          ];
          if (retirement === 'cue-before-buffer-done') deferredDone = events.pop();
          controller.enqueue(
            new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')),
          );
          // Deliberately keep the response open after done.
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const root = createRoot(document.createElement('div'));
    const ref = createRef<ChatAreaRef>();
    const onCueUser = vi.fn();
    const onCueUserCleared = vi.fn();
    let mounted = true;
    let first!: Promise<void>;
    let reply!: Promise<void>;
    let release: ((value: object) => void) | undefined;
    try {
      await act(async () =>
        root.render(createElement(ChatArea, { ref, onCueUser, onCueUserCleared })),
      );
      await act(async () => {
        first = ref.current!.sendMessage('Explain');
      });
      if (retirement === 'cue-before-buffer-done') {
        for (
          let tick = 0;
          tick < 100 && fixture.state.chats[0]?.status !== 'waiting-user';
          tick++
        ) {
          await act(async () => vi.advanceTimersByTimeAsync(30));
        }
      } else {
        await act(async () => vi.advanceTimersByTimeAsync(3_000));
      }
      expect(requests).toHaveLength(1);
      expect(fixture.state.chats[0]?.status).toBe('waiting-user');
      const hydrationCount = onCueUser.mock.calls.length;
      if (deferredDone) {
        await act(async () =>
          streams[0]!.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify(deferredDone)}\n\n`),
          ),
        );
        // No pacing tick follows the separately received done event.
      }

      fixture.capabilities.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      await act(async () => {
        reply = ref.current!.sendMessage('Practice');
        void ref.current!.sendMessage('Practice');
      });
      expect(fixture.state.chats[0]?.status).toBe('active');
      expect(fixture.state.chats[0]?.cueUser).toBeUndefined();
      expect(onCueUserCleared).toHaveBeenCalledTimes(1);
      expect(onCueUser).toHaveBeenCalledTimes(hydrationCount);
      if (retirement.endsWith('during-preparation')) {
        if (retirement === 'stop-during-preparation')
          await act(async () => ref.current!.stopActiveSession());
        else if (retirement === 'unmount-during-preparation') {
          act(() => root.unmount());
          mounted = false;
        } else {
          fixture.state.stage.id = 'new-stage';
          fixture.state.chats = [];
          await act(async () =>
            root.render(createElement(ChatArea, { ref, onCueUser, onCueUserCleared })),
          );
        }
        await act(async () => {
          release!({});
        });
        expect(requests).toHaveLength(1);
        await reply;
        if (retirement === 'stop-during-preparation')
          expect(fixture.state.chats[0]?.status).toBe('completed');
        return;
      }
      await act(async () => {
        release!({});
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.directorState).toEqual({
        turnCount: 1,
        agentResponses: [],
        whiteboardLedger: [],
      });
      expect(
        requests[1]?.messages.filter(
          (m) =>
            m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === 'Practice'),
        ),
      ).toHaveLength(1);
      expect(fixture.state.chats[0]?.messages.find((m) => m.id === 'question')?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: 'What now?' }),
      ]);
      expect(onCueUser).toHaveBeenCalledTimes(1);
      if (retirement === 'late-eof') {
        await act(async () => {
          streams[0]!.close();
          await first;
        });
        expect(fixture.state.chats[0]?.status).toBe('active');
        expect(fixture.state.chats[0]?.cueUser).toBeUndefined();
        expect(onCueUser).toHaveBeenCalledTimes(1);
        expect(requests).toHaveLength(2);
      }
    } finally {
      await act(async () => {
        release?.({});
      });
      if (mounted) act(() => root.unmount());
      for (const stream of streams) {
        try {
          stream.error(new DOMException('Aborted', 'AbortError'));
        } catch {
          /* already retired */
        }
      }
      await Promise.all([first, reply]);
    }
  },
  15_000,
);
