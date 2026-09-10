import { describe, expect, it } from 'vitest';
import {
  paneAvailabilityRetryDelay,
  shouldResumeClassroomGeneration,
} from '@/lib/classroom/progressive-load-policy';

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
    { loading: true, error: null, transportPersistenceFenced: false, generationStarted: false },
    {
      loading: false,
      error: 'failed',
      transportPersistenceFenced: false,
      generationStarted: false,
    },
    { loading: false, error: null, transportPersistenceFenced: true, generationStarted: false },
    { loading: false, error: null, transportPersistenceFenced: false, generationStarted: true },
  ])('blocks generation resume while progressive state is unsafe: %o', (state) => {
    expect(shouldResumeClassroomGeneration(state)).toBe(false);
  });

  it('allows generation resume only after loading and transport fencing settle', () => {
    expect(
      shouldResumeClassroomGeneration({
        loading: false,
        error: null,
        transportPersistenceFenced: false,
        generationStarted: false,
      }),
    ).toBe(true);
  });
});
