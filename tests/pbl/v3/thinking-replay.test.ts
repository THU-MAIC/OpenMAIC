// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { ThinkingBlock } from '@/components/workbench/chat/thinking-block';
import { projectConversation } from '@/lib/server/pbl-v3/conversation';
import { createThinkingTimingTracker } from '@/lib/server/pbl-v3/thinking-timing';
import type { PersistedAgentSessionEvent } from '@openmaic/storage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('keeps an expanded thinking block open as compacted live snapshots replace one another', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const track = createThinkingTimingTracker();
  const snapshot = (text: string) => ({
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] },
  });
  const event = (id: number, type: string, data: unknown): PersistedAgentSessionEvent => ({
    id,
    ts: id,
    type,
    attempt: 1,
    data: track(type, data, id),
  });
  const start = event(1, 'message_start', snapshot(''));
  const render = async (update: PersistedAgentSessionEvent, running = true) => {
    const part = projectConversation([start, update], 'coder', running)[0]!.parts[0]!;
    if (part.kind !== 'thinking') throw new Error('Expected thinking');
    await act(async () =>
      root.render(
        createElement(ThinkingBlock, {
          key: part.id,
          text: part.text,
          streaming: part.streaming,
          startedAt: part.startedAt,
          endedAt: part.endedAt,
        }),
      ),
    );
  };
  try {
    await render(event(5, 'message_update', snapshot('First thought')));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[data-open="true"]')).not.toBeNull();
    await render(event(20, 'message_update', snapshot('More reasoning')));
    expect(container.querySelector('[data-open="true"]')).not.toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('More reasoning');
    await render(event(30, 'message_end', snapshot('Complete reasoning')), false);
    expect(container.querySelector('[data-open="true"]')).not.toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('Complete reasoning');
  } finally {
    await act(async () => root.unmount());
  }
});
