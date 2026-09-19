import { describe, expect, it } from 'vitest';
import type { ChatNode } from '@/lib/workbench/session-store';
import {
  aggregateToolGroupStatus,
  initialToolGroupOpen,
  shouldScheduleAutoCollapse,
  toolGroupCollapseDelayMs,
  TOOL_GROUP_AUTO_COLLAPSE_MS,
  TOOL_GROUP_MIN_VISIBLE_MS,
} from '@/components/workbench/chat/tool-group-state';

function tool(name: string, key: string, toolState: ChatNode['toolState']): ChatNode {
  return { key, kind: 'tool', text: '', toolName: name, toolState };
}

describe('aggregateToolGroupStatus', () => {
  it('is running while any call is still running', () => {
    const nodes = [tool('read_scene', 'r1', 'done'), tool('generate_scene', 'g1', 'running')];
    expect(aggregateToolGroupStatus(nodes)).toBe('running');
  });

  it('is error when a call failed and none are running', () => {
    const nodes = [tool('read_scene', 'r1', 'done'), tool('generate_scene', 'g1', 'failed')];
    expect(aggregateToolGroupStatus(nodes)).toBe('error');
  });

  it('is done once every call settled successfully', () => {
    const nodes = [tool('read_scene', 'r1', 'done'), tool('generate_scene', 'g1', 'done')];
    expect(aggregateToolGroupStatus(nodes)).toBe('done');
  });
});

describe('initialToolGroupOpen', () => {
  it('starts expanded only while the group is running', () => {
    expect(initialToolGroupOpen('running')).toBe(true);
    expect(initialToolGroupOpen('done')).toBe(false);
    expect(initialToolGroupOpen('error')).toBe(false);
  });
});

describe('shouldScheduleAutoCollapse', () => {
  it('owes a collapse once an open group has settled', () => {
    expect(shouldScheduleAutoCollapse('done', true, false)).toBe(true);
    expect(shouldScheduleAutoCollapse('error', true, false)).toBe(true);
  });

  it('owes nothing while calls are still running', () => {
    expect(shouldScheduleAutoCollapse('running', true, false)).toBe(false);
  });

  it('owes nothing to an already collapsed group — a replayed timeline stays still', () => {
    expect(shouldScheduleAutoCollapse('done', false, false)).toBe(false);
    expect(shouldScheduleAutoCollapse('running', false, false)).toBe(false);
  });

  it('respects a manual fold choice over auto-collapse', () => {
    expect(shouldScheduleAutoCollapse('done', true, true)).toBe(false);
  });

  it('leaves a breathing pause before folding, long enough to read the settled head', () => {
    expect(TOOL_GROUP_AUTO_COLLAPSE_MS).toBeGreaterThanOrEqual(400);
    expect(TOOL_GROUP_AUTO_COLLAPSE_MS).toBeLessThanOrEqual(1000);
  });
});

describe('toolGroupCollapseDelayMs', () => {
  const T0 = 1_000_000;

  it('holds a fast group until its minimum time on screen', () => {
    // Everything settled 200ms after the group appeared: the settle pause alone
    // would close it at +800ms, barely a blink. The floor carries it to +1800.
    const settledAt = T0 + 200;
    expect(toolGroupCollapseDelayMs(settledAt, T0, settledAt)).toBe(
      TOOL_GROUP_MIN_VISIBLE_MS - 200,
    );
  });

  it('lets a slow group fold on the settle pause alone', () => {
    // Six seconds of tool work: the visibility floor is long past, so the group
    // closes exactly one breathing pause after it settled.
    const settledAt = T0 + 6_000;
    expect(toolGroupCollapseDelayMs(settledAt, T0, settledAt)).toBe(TOOL_GROUP_AUTO_COLLAPSE_MS);
  });

  it('takes whichever deadline is later, never their sum', () => {
    // Right at the crossover the two deadlines coincide; one step past it the
    // settle pause owns the wait, and neither side stacks one wait on the other.
    const crossover = T0 + (TOOL_GROUP_MIN_VISIBLE_MS - TOOL_GROUP_AUTO_COLLAPSE_MS);
    expect(toolGroupCollapseDelayMs(crossover, T0, crossover)).toBe(TOOL_GROUP_AUTO_COLLAPSE_MS);
    expect(toolGroupCollapseDelayMs(crossover + 1, T0, crossover + 1)).toBe(
      TOOL_GROUP_AUTO_COLLAPSE_MS,
    );
    const fast = T0 + 200;
    expect(toolGroupCollapseDelayMs(fast, T0, fast)).toBeLessThan(
      TOOL_GROUP_MIN_VISIBLE_MS + TOOL_GROUP_AUTO_COLLAPSE_MS,
    );
  });

  it('counts down from now, so a re-timed window does not restart the floor', () => {
    // A call went back to running and settled again later: the group is still
    // the same group, so its floor is still measured from when it appeared —
    // only the settle pause is re-timed off the new settle.
    const settledAt = T0 + 5_000;
    expect(toolGroupCollapseDelayMs(settledAt, T0, settledAt)).toBe(TOOL_GROUP_AUTO_COLLAPSE_MS);
    // Scheduling late inside the window (a re-render mid-pause) shortens the
    // remaining wait instead of extending it.
    expect(toolGroupCollapseDelayMs(settledAt + 400, T0, settledAt)).toBe(
      TOOL_GROUP_AUTO_COLLAPSE_MS - 400,
    );
  });

  it('never asks for a negative wait once both deadlines are past', () => {
    const settledAt = T0 + 100;
    expect(toolGroupCollapseDelayMs(T0 + 60_000, T0, settledAt)).toBe(0);
  });

  it('keeps a fast group readable — the floor clears the fold transition itself', () => {
    // 220ms of grid transition plus the settle pause has to leave real dwell
    // time, and the floor must not stall the rail either.
    expect(TOOL_GROUP_MIN_VISIBLE_MS).toBeGreaterThanOrEqual(1500);
    expect(TOOL_GROUP_MIN_VISIBLE_MS).toBeLessThanOrEqual(2000);
    expect(TOOL_GROUP_MIN_VISIBLE_MS).toBeGreaterThan(TOOL_GROUP_AUTO_COLLAPSE_MS);
  });
});
