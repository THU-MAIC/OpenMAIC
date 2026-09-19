import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatSaveBrake } from '@/lib/utils/chat-save-brake';

function warnedText(): string {
  return (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => String(call[0]))
    .join('\n');
}

describe('chatSaveBrake — autosave cooldown after a failed chat save', () => {
  beforeEach(() => {
    chatSaveBrake.resetAll();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows a stage until a failure is recorded', () => {
    expect(chatSaveBrake.allows('s1', 1_000_000)).toBe(true);
  });

  it('holds that stage for a growing cooldown and caps at 5 minutes', () => {
    const t0 = 1_000_000;
    const delays = [1, 2, 3, 4, 5, 6].map((n) =>
      chatSaveBrake.recordFailure('s1', { status: 503, code: 'X' }, t0 + n),
    );
    expect(delays).toEqual([5_000, 15_000, 45_000, 120_000, 300_000, 300_000]);
    expect(chatSaveBrake.allows('s1', t0 + 6 + 299_999)).toBe(false);
    expect(chatSaveBrake.allows('s1', t0 + 6 + 300_000)).toBe(true);
  });

  it('does not hold other stages', () => {
    const t0 = 1_000_000;
    chatSaveBrake.recordFailure('s1', { status: 503 }, t0);
    expect(chatSaveBrake.allows('s2', t0)).toBe(true);
  });

  it('clears on success so the next save is allowed immediately', () => {
    const t0 = 5_000;
    chatSaveBrake.recordFailure('s1', { status: 503, message: 'unavailable' }, t0);
    expect(chatSaveBrake.allows('s1', t0 + 1)).toBe(false);
    chatSaveBrake.recordSuccess('s1');
    expect(chatSaveBrake.allows('s1', t0 + 1)).toBe(true);
  });

  it('logs HTTP status, code, and message once per trip', () => {
    chatSaveBrake.recordFailure(
      's1',
      { status: 503, code: 'PERSISTENCE_DEV_TOKEN_MISSING', message: 'nope' },
      5_000,
    );
    const warned = warnedText();
    expect(warned).toContain('HTTP 503 · PERSISTENCE_DEV_TOKEN_MISSING · nope');
    expect(warned).toContain('holding autosave for 5 s');
    expect(warned.match(/holding autosave/g)).toHaveLength(1);
  });
});
