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
  serverBackedMedia: false,
  ownership: 'owner',
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
  ])('blocks generation resume while progressive state is unsafe: %o', (state) => {
    expect(shouldResumeClassroomGeneration(state)).toBe(false);
  });

  it('allows generation resume only after loading and transport fencing settle', () => {
    expect(shouldResumeClassroomGeneration(settled)).toBe(true);
  });

  it('applies the ownership gate on top of the progressive state', () => {
    expect(
      shouldResumeClassroomGeneration({
        ...settled,
        serverBackedMedia: true,
        ownership: 'not-owner',
      }),
    ).toBe(false);
    expect(
      shouldResumeClassroomGeneration({
        ...settled,
        serverBackedMedia: true,
        ownership: 'unresolved',
      }),
    ).toBe(false);
    expect(
      shouldResumeClassroomGeneration({ ...settled, serverBackedMedia: true, ownership: 'owner' }),
    ).toBe(true);
    expect(
      shouldResumeClassroomGeneration({
        ...settled,
        serverBackedMedia: true,
        ownership: 'ownerless',
      }),
    ).toBe(true);
  });

  it('keeps an unsafe progressive state decisive even for an owner', () => {
    expect(
      shouldResumeClassroomGeneration({
        ...settled,
        loading: true,
        serverBackedMedia: true,
        ownership: 'owner',
      }),
    ).toBe(false);
  });
});
