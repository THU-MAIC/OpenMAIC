// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import type { ChatSession } from '@/lib/types/chat';
import { ActionEngine } from '@/lib/action/engine';

const fixture = vi.hoisted(() => ({
  state: {
    stage: { id: 'ephemeral-options', name: 'Cue replies', createdAt: 1, updatedAt: 1 },
    chats: [] as ChatSession[],
    scenes: [],
    outlines: [],
    currentSceneId: null,
    mode: 'playback',
    setChats(chats: ChatSession[]) {
      this.chats = chats;
    },
  },
}));
vi.mock('@/lib/store', () => ({
  useStageStore: Object.assign(
    (select: (state: typeof fixture.state) => unknown) => select(fixture.state),
    { getState: () => fixture.state },
  ),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/model-settings/capabilities', () => ({
  loadModelCapabilities: async () => ({}),
  classroomChatUsable: () => true,
}));
vi.mock('@/components/chat/session-list', () => ({ SessionList: () => null }));
vi.mock('@/components/chat/lecture-notes-view', () => ({ LectureNotesView: () => null }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([false, true])(
  'keeps a late SSE buffer paused and cancels it on session stop (%s)',
  async (stop) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    fixture.state.chats = [];
    let delivery!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        delivery = controller;
      },
    });
    const fetch = vi.fn(
      async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const execute = vi.spyOn(ActionEngine.prototype, 'execute').mockResolvedValue(undefined);
    const live = vi.fn();
    const root = createRoot(document.createElement('div'));
    const ref = createRef<ChatAreaRef>();
    try {
      await act(async () => root.render(createElement(ChatArea, { ref, onLiveSpeech: live })));
      let run!: Promise<void>;
      await act(async () => {
        run = ref.current!.sendMessage('Late response');
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(ref.current!.pauseActiveLiveBuffer()).toBe(true);
      if (stop) await act(async () => ref.current!.endActiveSession());
      await act(async () => {
        const events = [
          {
            type: 'agent_start',
            data: { messageId: 'late', agentId: 'default-1', agentName: 'Teacher' },
          },
          { type: 'text_delta', data: { messageId: 'late', content: 'Late buffered text.' } },
          {
            type: 'action',
            data: {
              messageId: 'late',
              actionId: 'late-action',
              actionName: 'spotlight',
              params: { elementId: 'target' },
            },
          },
          { type: 'agent_end', data: { messageId: 'late', agentId: 'default-1' } },
          { type: 'cue_user', data: { fromAgentId: 'default-1', prompt: 'Done?' } },
          { type: 'done', data: { totalAgents: 1, totalActions: 1, cueUserReceived: true } },
        ];
        delivery.enqueue(
          new TextEncoder().encode(
            events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''),
          ),
        );
        delivery.close();
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(execute).not.toHaveBeenCalled();
      expect(
        live.mock.calls.some(([text]) => typeof text === 'string' && text.includes('Late')),
      ).toBe(false);
      if (!stop) {
        await act(async () => {
          ref.current!.resumeActiveLiveBuffer();
          await vi.advanceTimersByTimeAsync(4000);
          await run;
        });
        expect(execute).toHaveBeenCalledOnce();
        expect(
          live.mock.calls.some(([text]) => typeof text === 'string' && text.includes('Late')),
        ).toBe(true);
      }
    } finally {
      act(() => root.unmount());
    }
  },
);

it('carries string suggestions through real SSE without saving them and sends return-to-lesson as ordinary text', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  fixture.state.chats = [];
  const requests: Array<{ messages: ChatSession['messages'] }> = [];
  const options = ['Show an example', 'Back to the lesson'];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const n = requests.length;
    const events = [
      {
        type: 'agent_start',
        data: { messageId: 'question-' + n, agentId: 'default-1', agentName: 'Teacher' },
      },
      { type: 'text_delta', data: { messageId: 'question-' + n, content: 'Which example?' } },
      { type: 'agent_end', data: { messageId: 'question-' + n, agentId: 'default-1' } },
      {
        type: 'cue_user',
        data: { fromAgentId: 'default-1', prompt: 'Any more?', ...(n === 1 ? { options } : {}) },
      },
      {
        type: 'done',
        data: { totalActions: 0, totalAgents: 1, agentHadContent: true, cueUserReceived: true },
      },
    ];
    return new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const root = createRoot(document.createElement('div'));
  const ref = createRef<ChatAreaRef>();
  const onCueUser = vi.fn();
  try {
    await act(async () => root.render(createElement(ChatArea, { ref, onCueUser })));
    let first!: Promise<void>;
    await act(async () => {
      first = ref.current!.sendMessage('Explain');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await first;
    });
    expect(onCueUser).toHaveBeenCalledExactlyOnceWith('default-1', 'Any more?', options);
    expect(fixture.state.chats[0]?.status).toBe('active');
    expect(JSON.stringify(fixture.state.chats)).not.toContain('"options"');
    expect(JSON.stringify(fixture.state.chats)).not.toContain('waiting-user');
    let reply!: Promise<void>;
    await act(async () => {
      reply = ref.current!.sendMessage(options[1]!);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await reply;
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)?.parts).toEqual([
      { type: 'text', text: 'Back to the lesson' },
    ]);
    expect(onCueUser).toHaveBeenLastCalledWith('default-1', 'Any more?');
  } finally {
    act(() => root.unmount());
  }
});
