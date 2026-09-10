// @vitest-environment node

/**
 * The gap indicator at the end of an exchange.
 *
 * The thinking indicator is the LLM-gap row: opened when the next call is in flight with
 * nothing on screen yet, and removed the moment content arrives. Two paths used
 * to close it — content arriving, and the run settling (`session_end`) — and an
 * exchange that produced only tool calls and then ended reached NEITHER, so the
 * row sat there until the whole run settled.
 *
 * The close for that case was written, but it lived in a SECOND
 * `case 'agent_end'` further down the same switch, where a switch can never
 * reach it. What is pinned here is the behaviour, not the shape: the exchange's
 * own end closes its gap, and doing so does not disturb the course row that the
 * same event flushes.
 */
import { describe, expect, it } from 'vitest';

import {
  createInitialSessionState,
  foldEvent,
  foldEvents,
  type WorkbenchEvent,
  type WorkbenchFold,
} from '@/lib/workbench/session-store';

const seed = (): WorkbenchFold => createInitialSessionState();

let seq = 0;
function ev(type: string, data: unknown = {}): WorkbenchEvent {
  seq += 1;
  return { id: seq, ts: 1000 + seq, attempt: 1, type, data };
}

const hasGap = (fold: WorkbenchFold) => fold.chat.some((node) => node.kind === 'waiting');

describe('agent_end closes the exchange’s gap indicator', () => {
  it('opens a gap on session_start and clears it when the exchange ends', () => {
    const started = foldEvent(seed(), ev('session_start', { prompt: '把第 3 页改一下' }));
    expect(hasGap(started)).toBe(true);

    const ended = foldEvent(started, ev('agent_end'));

    expect(hasGap(ended)).toBe(false);
    expect(ended.waitingArmed).toBe(false);
  });

  it('still flushes the exchange’s course row while clearing the gap', () => {
    const folded = foldEvents(seed(), [
      ev('session_start', { prompt: '改这门课' }),
      ev('stage_link', { stageId: 'stage-a' }),
      ev('agent_end'),
    ]);

    expect(folded.chat.filter((node) => node.kind === 'course')).toHaveLength(1);
    expect(hasGap(folded)).toBe(false);
  });
});
