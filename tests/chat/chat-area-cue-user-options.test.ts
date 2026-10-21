// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import type { ChatSession } from '@/lib/types/chat';

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
