import { describe, expect, it } from 'vitest';
import { FOREGROUND_SCENE_RETRY_OPTIONS } from '@/app/generation-preview/foreground-retry';

describe('foreground scene retry budget', () => {
  it('limits the visible first scene to two retries', () => {
    expect(FOREGROUND_SCENE_RETRY_OPTIONS.maxRetries).toBe(2);
  });
});
