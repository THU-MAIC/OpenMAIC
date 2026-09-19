import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { createPartMapper } from '@/lib/agent/runtime/stream-fn';
import {
  hasRenderableAssistantUpdate,
  snapshotEventDataForLog,
} from '@/lib/server/agent-runtime/runner';
import { ChatTimeline } from '@/components/workbench/chat/chat-timeline';
import { foldEvent, type WorkbenchEvent, type WorkbenchFold } from '@/lib/workbench/session-store';

function emptyPartial(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'unknown' as never,
    provider: 'unknown' as never,
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  };
}

const blankFold: WorkbenchFold = {
  status: 'connecting',
  lastEventId: 0,
  error: null,
  courseTitle: null,
  sessionPrompt: null,
  sessionTitle: null,
  skillId: null,
  skillViolations: [],
  plan: [],
  pages: {},
  chat: [],
  libraryRevision: 0,
  stageLinkStageIds: [],
  touchedStageIds: [],
  runCourseStageIds: [],
  generatingOrder: null,
  panelOpen: false,
  panelPinned: false,
  thinkingKey: null,
  assistantKey: null,
  generationOpen: false,
  epoch: 0,
  waitingKey: null,
  waitingArmed: false,
  stageId: null,
};

function event(id: number, type: string, data: unknown): WorkbenchEvent {
  return { id, ts: id * 100, attempt: 1, type, data };
}

describe('reasoning stream through the workbench seams', () => {
  it('mounts the thinking strip before the assistant message completes', () => {
    const partial = emptyPartial();
    const driverEvents: AssistantMessageEvent[] = [];
    const mapper = createPartMapper(partial, (driverEvent) => driverEvents.push(driverEvent));

    mapper.handle({ type: 'reasoning-delta', text: 'Check the source first' });

    const firstDriverEvent = driverEvents[0] as Extract<
      AssistantMessageEvent,
      { type: 'thinking_start' }
    >;
    const startUpdate = { type: 'message_update', message: firstDriverEvent.partial };
    expect(hasRenderableAssistantUpdate(startUpdate)).toBe(true);
    const runnerFrame = snapshotEventDataForLog('message_update', startUpdate);

    // The route forwards the durable JSON value, not the driver's mutable object.
    const forwarded = JSON.parse(JSON.stringify(runnerFrame)) as unknown;
    let state = foldEvent(blankFold, event(1, 'session_start', { prompt: 'Audit this' }));
    state = foldEvent(state, event(2, 'message_start', { message: emptyPartial() }));
    state = foldEvent(state, event(3, 'message_update', forwarded));

    const thinking = state.chat.find((node) => node.kind === 'thinking');
    expect(thinking).toMatchObject({ text: 'Check the source first', streaming: true });
    const html = renderToStaticMarkup(createElement(ChatTimeline, { chat: state.chat, plan: [] }));
    expect(html).toContain('data-testid="workbench-thinking-bar"');
    expect(html).toContain('data-streaming="true"');
  });

  it('does not let an empty thinking_start consume the runner throttle slot', () => {
    const emptyStart = {
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
    };
    expect(hasRenderableAssistantUpdate(emptyStart)).toBe(false);
    expect(
      hasRenderableAssistantUpdate({
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'now visible' }] },
      }),
    ).toBe(true);
  });

  it('snapshots the shared partial before the driver mutates its next delta', () => {
    const partial = emptyPartial();
    const mapper = createPartMapper(partial, () => {});
    mapper.handle({ type: 'reasoning-delta', text: 'first' });
    const snapshot = snapshotEventDataForLog('message_update', {
      message: partial,
    }) as { message: { content: Array<{ thinking?: string }> } };
    mapper.handle({ type: 'reasoning-delta', text: ' second' });
    expect(snapshot.message.content[0]?.thinking).toBe('first');
    expect((partial.content[0] as { thinking: string }).thinking).toBe('first second');
  });
});
