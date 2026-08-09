import { describe, expect, it } from 'vitest';

import { createGroundingContextRef } from '@/lib/rag';

describe('RAG grounding seam', () => {
  it('does not create a grounding reference when no snapshot is supplied', () => {
    expect(createGroundingContextRef()).toBeUndefined();
    expect(createGroundingContextRef('   ')).toBeUndefined();
  });

  it('preserves only a trimmed opaque snapshot ID', () => {
    expect(createGroundingContextRef(' snapshot-1 ')).toEqual({ snapshotId: 'snapshot-1' });
  });
});
