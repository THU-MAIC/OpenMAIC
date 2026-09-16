import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chatSaveBrake } from '@/lib/utils/chat-save-brake';

describe('chatSaveBrake — autosave cooldown after a failed chat save', () => {
  beforeEach(() => {
    chatSaveBrake.resetAll();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows saves until a failure, then holds with a growing schedule capped at 5 minutes', () => {
    const t0 = 1_000_000;
    expect(chatSaveBrake.allows('s1', t0)).toBe(true);
    const delays = [1, 2, 3, 4, 5, 6].map((n) =>
      chatSaveBrake.recordFailure('s1', { status: 503, code: 'X' }, t0 + n),
    );
    expect(delays).toEqual([5_000, 15_000, 45_000, 120_000, 300_000, 300_000]);
    expect(chatSaveBrake.allows('s1', t0 + 6 + 299_999)).toBe(false);
    expect(chatSaveBrake.allows('s1', t0 + 6 + 300_000)).toBe(true);
    // Other stages are independent.
    expect(chatSaveBrake.allows('s2', t0 + 6)).toBe(true);
  });

  it('releases on success and reports the store answer (status · code · message) once per trip', () => {
    const t0 = 5_000;
    chatSaveBrake.recordFailure(
      's1',
      { status: 503, code: 'PERSISTENCE_DEV_TOKEN_MISSING', message: 'nope' },
      t0,
    );
    expect(chatSaveBrake.allows('s1', t0 + 1)).toBe(false);
    chatSaveBrake.recordSuccess('s1');
    expect(chatSaveBrake.allows('s1', t0 + 1)).toBe(true);
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(warned).toContain('HTTP 503 · PERSISTENCE_DEV_TOKEN_MISSING · nope');
    expect(warned).toContain('holding autosave for 5 s');
  });
});
