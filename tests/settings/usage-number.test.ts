import { describe, expect, it } from 'vitest';
import { formatUsageNumber } from '@/lib/utils/usage-number';

describe('formatUsageNumber', () => {
  it('keeps the existing output away from unit boundaries', () => {
    expect(formatUsageNumber(0)).toBe('0');
    expect(formatUsageNumber(42.4)).toBe('42');
    expect(formatUsageNumber(999)).toBe('999');
    expect(formatUsageNumber(1_000)).toBe('1.0K');
    expect(formatUsageNumber(12_345)).toBe('12.3K');
    expect(formatUsageNumber(999_949)).toBe('999.9K');
    expect(formatUsageNumber(1_000_000)).toBe('1.00M');
    expect(formatUsageNumber(4_567_890)).toBe('4.57M');
  });

  it('moves to the next unit when rounding reaches it', () => {
    expect(formatUsageNumber(999_950)).toBe('1.00M');
    expect(formatUsageNumber(999_999)).toBe('1.00M');
    expect(formatUsageNumber(999.5)).toBe('1.0K');
    expect(formatUsageNumber(999.9)).toBe('1.0K');
  });
});
