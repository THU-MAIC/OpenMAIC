import { describe, expect, it } from 'vitest';

import {
  createLegacyUrlProbeBudget,
  LEGACY_URL_PROBE_TIMEOUT_MS,
} from '@/lib/media/legacy-url-probe-budget';

describe('legacy URL probe budget', () => {
  it('caps a request to the remaining shared wall-clock budget', () => {
    let now = 1_000;
    const budget = createLegacyUrlProbeBudget(60_000, LEGACY_URL_PROBE_TIMEOUT_MS, () => now);

    expect(budget.nextTimeoutMs()).toBe(LEGACY_URL_PROBE_TIMEOUT_MS);

    now += 57_500;
    expect(budget.remainingMs()).toBe(2_500);
    expect(budget.nextTimeoutMs()).toBe(2_500);
  });

  it('prevents queued requests from starting after the deadline', () => {
    let now = 1_000;
    const budget = createLegacyUrlProbeBudget(100, LEGACY_URL_PROBE_TIMEOUT_MS, () => now);

    now += 100;

    expect(budget.remainingMs()).toBe(0);
    expect(budget.nextTimeoutMs()).toBeNull();
  });
});
