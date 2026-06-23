import { describe, it, expect } from 'vitest';
import { nextThinkTimer, formatThinkDuration } from '@/lib/agent/client/thinking-timers';

describe('nextThinkTimer (per reasoning block)', () => {
  it('starts the timer on the first observation of a block', () => {
    expect(nextThinkTimer(undefined, { end: false, now: 100 })).toEqual({ startedAt: 100 });
  });

  it('stays open while the block is still the last part (end=false)', () => {
    const started = { startedAt: 100 };
    expect(nextThinkTimer(started, { end: false, now: 300 })).toEqual(started);
  });

  it('ends the block when a later part follows it (end=true)', () => {
    const started = { startedAt: 100 };
    expect(nextThinkTimer(started, { end: true, now: 250 })).toEqual({
      startedAt: 100,
      endedAt: 250,
    });
  });

  it('keeps the first endedAt (does not move once ended)', () => {
    const ended = { startedAt: 100, endedAt: 250 };
    expect(nextThinkTimer(ended, { end: true, now: 999 })).toEqual(ended);
  });
});

describe('formatThinkDuration', () => {
  it('shows one decimal under 10s', () => {
    expect(formatThinkDuration(1234)).toBe('1.2s');
  });
  it('rounds to whole seconds at/above 10s', () => {
    expect(formatThinkDuration(12600)).toBe('13s');
  });
  it('clamps negatives to 0', () => {
    expect(formatThinkDuration(-5)).toBe('0.0s');
  });
});
