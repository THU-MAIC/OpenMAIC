import { describe, expect, it } from 'vitest';
import {
  appendCompactedReplayEvent,
  compactReplayEvents,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';

function ev(id: number, type: string, data: Record<string, unknown> = {}): WorkbenchEvent {
  return { id, ts: id, attempt: 1, type, data };
}

describe('compactReplayEvents', () => {
  it('keeps the first and last message_update in a streaming run', () => {
    // The last update carries the full text; the FIRST carries the stream's
    // start timestamp, so a replayed thinking bar keeps the duration the user
    // watched live instead of redrawing a shorter one after refresh.
    const compacted = compactReplayEvents([
      ev(1, 'session_start', { prompt: 'hi' }),
      ev(2, 'message_update', { message: { thinking: 'a' } }),
      ev(3, 'message_update', { message: { thinking: 'ab' } }),
      ev(4, 'message_update', { message: { thinking: 'abc' } }),
      ev(5, 'message_end', { message: { thinking: 'abc', text: '好' } }),
    ]);
    expect(compacted.map((e) => e.id)).toEqual([1, 2, 4, 5]);
  });

  it('keeps a single message_update run of one as-is', () => {
    const compacted = compactReplayEvents([
      ev(1, 'session_start', { prompt: 'hi' }),
      ev(2, 'message_update', { message: { thinking: 'a' } }),
      ev(3, 'message_end', { message: { thinking: 'a' } }),
    ]);
    expect(compacted.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('keeps at most the live trace ring from a long trace run', () => {
    const traces = Array.from({ length: 250 }, (_, i) => ev(i + 1, 'trace', { message: `t${i}` }));
    const compacted = compactReplayEvents(traces);
    expect(compacted).toHaveLength(200);
    expect(compacted[0]?.id).toBe(51);
    expect(compacted.at(-1)?.id).toBe(250);
  });

  it('does not drop non-streaming events', () => {
    const compacted = compactReplayEvents([
      ev(1, 'user_message', { text: '改一下' }),
      ev(2, 'tool_execution_start', { toolName: 'list_scenes' }),
      ev(3, 'tool_execution_end', { toolName: 'list_scenes' }),
    ]);
    expect(compacted.map((e) => e.type)).toEqual([
      'user_message',
      'tool_execution_start',
      'tool_execution_end',
    ]);
  });

  it('compacts streaming frames incrementally while the backlog is filling', () => {
    const backlog: WorkbenchEvent[] = [];
    appendCompactedReplayEvent(backlog, ev(1, 'session_start', { prompt: 'hi' }));
    appendCompactedReplayEvent(backlog, ev(2, 'message_update', { message: { thinking: 'a' } }));
    appendCompactedReplayEvent(backlog, ev(3, 'message_update', { message: { thinking: 'ab' } }));
    appendCompactedReplayEvent(backlog, ev(4, 'message_update', { message: { thinking: 'abc' } }));
    // First and last of the run survive; the middle is dropped in place.
    expect(backlog.map((e) => e.id)).toEqual([1, 2, 4]);
  });

  it('incremental compaction matches the batch compaction', () => {
    const backlog: WorkbenchEvent[] = [];
    const frames = [
      ev(1, 'session_start', { prompt: 'hi' }),
      ev(2, 'message_update', { message: { thinking: 'a' } }),
      ev(3, 'message_update', { message: { thinking: 'ab' } }),
      ev(4, 'message_end', { message: { thinking: 'ab' } }),
      ev(5, 'message_update', { message: { thinking: 'x' } }),
      ev(6, 'message_end', { message: { thinking: 'x' } }),
    ];
    for (const frame of frames) appendCompactedReplayEvent(backlog, frame);
    expect(backlog.map((e) => e.id)).toEqual(compactReplayEvents(frames).map((e) => e.id));
  });
});
