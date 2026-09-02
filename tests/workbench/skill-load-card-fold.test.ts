/**
 * The loading card is a function of the DURABLE MESSAGE FRAMES.
 *
 * A skill load can be pre-executed: the runner synthesizes
 * `assistant(toolCall read) → toolResult(SKILL.md)` so a `/handle` the user typed
 * is loaded rather than suggested, and nothing executes, so pi emits no
 * `tool_execution_*`. Deriving the card from the frames instead of from a pair of
 * side events is what stops the card and the transcript from being two writes that
 * have to agree across a crash.
 *
 * These pin the fold half: the card appears, it settles, a REAL execution does not
 * get two cards, and no other tool's behaviour moves.
 */
import { describe, expect, it } from 'vitest';

import {
  createInitialSessionState,
  foldEvents,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';

const SKILL_PATH = '/skills/agent-runtime/pro-editing/SKILL.md';

let seq = 0;
const event = (type: string, data: Record<string, unknown>): WorkbenchEvent =>
  ({ seq: (seq += 1), ts: seq * 10, attempt: 1, type, data }) as unknown as WorkbenchEvent;

const readCall = (id: string, path = SKILL_PATH) =>
  event('message_end', {
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'read', arguments: { path } }],
    },
  });

const readResult = (id: string, isError = false) =>
  event('message_end', {
    message: { role: 'toolResult', toolCallId: id, toolName: 'read', isError, content: [] },
  });

const fold = (events: WorkbenchEvent[]) => {
  seq = 0;
  return foldEvents(createInitialSessionState(), [
    event('session_start', { prompt: '做一节课' }),
    ...events,
  ]);
};
const cards = (events: WorkbenchEvent[]) =>
  fold(events).chat.filter((node) => node.kind === 'tool');

describe('a pre-executed skill load draws its own card', () => {
  it('opens on the assistant frame and closes on the tool result', () => {
    seq = 0;
    const opened = cards([readCall('call_a')]);
    expect(opened).toMatchObject([
      { toolName: 'read', toolState: 'running', toolArgs: { path: SKILL_PATH } },
    ]);
    seq = 0;
    expect(cards([readCall('call_a'), readResult('call_a')])).toMatchObject([
      { toolCallId: 'call_a', toolState: 'done' },
    ]);
  });

  it('marks a failed result failed', () => {
    expect(cards([readCall('call_a'), readResult('call_a', true)])).toMatchObject([
      { toolState: 'failed' },
    ]);
  });

  it('draws one card per call in a multi-skill turn', () => {
    expect(
      cards([
        readCall('call_a'),
        readResult('call_a'),
        readCall('call_b', '/skills/agent-runtime/slide-dsl/SKILL.md'),
        readResult('call_b'),
      ]).map((card) => card.toolCallId),
    ).toEqual(['call_a', 'call_b']);
  });

  it('is idempotent: a replayed assistant frame does not duplicate the card', () => {
    expect(cards([readCall('call_a'), readCall('call_a'), readResult('call_a')])).toHaveLength(1);
  });
});

describe('what it deliberately leaves alone', () => {
  it('does NOT draw a card for a read outside a skill directory', () => {
    // `skillLoadId` is the shared judge; a plain file read is not a skill load and
    // keeps drawing its card from `tool_execution_start` like every other tool.
    expect(cards([readCall('call_a', '/skills/agent-runtime/notes.md')])).toEqual([]);
    expect(cards([readCall('call_a', '/etc/passwd')])).toEqual([]);
  });

  it('does NOT draw a card for any other tool call', () => {
    expect(
      cards([
        event('message_end', {
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call_g', name: 'generate_scene', arguments: {} }],
          },
        }),
      ]),
    ).toEqual([]);
  });

  it('gives a REAL skill read exactly ONE card, not two', () => {
    // pi emits the assistant frame BEFORE it starts executing, so both signals
    // exist for a model-issued read. `tool_execution_start` upserts by call id.
    const folded = cards([
      readCall('call_a'),
      event('tool_execution_start', {
        toolCallId: 'call_a',
        toolName: 'read',
        args: { path: SKILL_PATH },
      }),
      event('tool_execution_end', { toolCallId: 'call_a', toolName: 'read', result: {} }),
      readResult('call_a'),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ toolCallId: 'call_a', toolState: 'done' });
  });

  it('leaves a non-skill tool’s own card untouched by the upsert', () => {
    const folded = cards([
      event('tool_execution_start', {
        toolCallId: 'call_g',
        toolName: 'generate_scene',
        args: { order: 3 },
      }),
      event('tool_execution_end', { toolCallId: 'call_g', toolName: 'generate_scene', result: {} }),
    ]);
    expect(folded).toMatchObject([
      { toolName: 'generate_scene', toolState: 'done', toolArgs: { order: 3 } },
    ]);
  });

  it('does not settle another tool’s running card from a tool result frame', () => {
    // #2055 (a lost `tool_execution_end` stranding a card) is still open for every
    // other tool; this path deliberately does not half-fix it for them.
    const folded = cards([
      event('tool_execution_start', {
        toolCallId: 'call_g',
        toolName: 'generate_scene',
        args: {},
      }),
      event('message_end', {
        message: { role: 'toolResult', toolCallId: 'call_g', toolName: 'generate_scene' },
      }),
    ]);
    expect(folded).toMatchObject([{ toolState: 'running' }]);
  });
});
