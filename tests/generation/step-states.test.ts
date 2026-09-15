import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => ({ agentMode: 'manual' }) },
}));
import { ALL_STEPS, createGenerationStepStates } from '@/app/generation-preview/types';

describe('generation step states', () => {
  it('initializes every configured step independently', () => {
    const states = createGenerationStepStates(ALL_STEPS, 2);
    expect(Object.keys(states)).toEqual(ALL_STEPS.map((step) => step.id));
    expect(states.outline).toEqual({ status: 'idle', attempt: 0, maxAttempts: 2 });
  });
});
