import { describe, expect, it } from 'vitest';

import { assertNotStreamError } from '@/components/scene-renderers/pbl/v2/use-instructor-stream';

describe('PBL v2 — instructor stream errors', () => {
  it('surfaces SSE error events instead of silently swallowing them', () => {
    expect(() =>
      assertNotStreamError({
        type: 'error',
        code: 'STREAM_ERROR',
        message: 'Invalid prompt: messages must not be empty',
      }),
    ).toThrow('STREAM_ERROR: Invalid prompt: messages must not be empty');
  });
});
