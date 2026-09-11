import { describe, expect, it } from 'vitest';
import {
  paneAvailabilityRetryDelay,
  shouldResumeClassroomGeneration,
} from '@/lib/classroom/progressive-load-policy';

const settled = {
  loading: false,
  error: null,
  transportPersistenceFenced: false,
  generationStarted: false,
  mayGenerate: true,
} as const;

describe('progressive classroom policy', () => {
  it('uses a bounded pane availability backoff', () => {
    expect(Array.from({ length: 6 }, (_, attempt) => paneAvailabilityRetryDelay(attempt))).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      null,
    ]);
  });

  it.each([
    { ...settled, loading: true },
    { ...settled, error: 'failed' },
    { ...settled, transportPersistenceFenced: true },
    { ...settled, generationStarted: true },
    { ...settled, mayGenerate: false },
  ])('blocks generation resume while progressive state is unsafe: %o', (state) => {
    expect(shouldResumeClassroomGeneration(state)).toBe(false);
  });

  it('allows generation resume only after loading and transport fencing settle', () => {
    expect(shouldResumeClassroomGeneration(settled)).toBe(true);
  });

  it('refuses whenever generation is not permitted, however settled the load is', () => {
    expect(shouldResumeClassroomGeneration({ ...settled, mayGenerate: false })).toBe(false);
  });

  it('keeps an unsafe progressive state decisive even when generation is permitted', () => {
    expect(shouldResumeClassroomGeneration({ ...settled, loading: true })).toBe(false);
  });
});
