import { describe, expect, it } from 'vitest';

import { resolveTaskEngineModeFromOutlineDoneEvent } from '@/app/generation-preview/vocational-mode';

describe('generation-preview vocational mode persistence', () => {
  it('uses server effective taskEngineMode from the done event', () => {
    expect(resolveTaskEngineModeFromOutlineDoneEvent({ taskEngineMode: true })).toBe(true);
    expect(resolveTaskEngineModeFromOutlineDoneEvent({ taskEngineMode: false })).toBe(false);
    expect(resolveTaskEngineModeFromOutlineDoneEvent({ effectiveTaskEngineMode: true })).toBe(true);
  });

  it('defaults to false when the done event omits effective mode', () => {
    expect(resolveTaskEngineModeFromOutlineDoneEvent({})).toBe(false);
    expect(resolveTaskEngineModeFromOutlineDoneEvent({ taskEngineMode: 'true' })).toBe(false);
  });
});
