import { describe, expect, it } from 'vitest';
import { getSoftCloseRemainingSeconds } from '@/components/chat/use-soft-close-countdown';

describe('getSoftCloseRemainingSeconds', () => {
  it('derives display time from an absolute deadline', () => {
    expect(getSoftCloseRemainingSeconds(15_000, 1_000)).toBe(14);
    expect(getSoftCloseRemainingSeconds(15_001, 1_000)).toBe(15);
    expect(getSoftCloseRemainingSeconds(1_000, 2_000)).toBe(0);
    expect(getSoftCloseRemainingSeconds(undefined, 2_000)).toBeUndefined();
  });
});
