/**
 * A parked allocation is scoped to one run of one course.
 *
 * Classic placeholders are reused across runs (`gen_img_1` is `gen_img_1` in
 * every deck), so an entry that survives an interrupted run would be handed to
 * a different slide of the next one — the previous deck's picture, silently, on
 * a slide whose provider was never asked.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPendingMediaAllocations,
  pendingMediaAllocation,
  recordPendingMediaAllocation,
  takePendingMediaAllocations,
} from '@/lib/media/pending-media-allocations';

const allocation = {
  stageId: 'stage-1',
  placeholderRef: 'gen_img_1',
  assetId: 'ast_old',
};

describe('pending media allocations', () => {
  beforeEach(() => clearPendingMediaAllocations());

  it('answers only for the course that parked it', () => {
    recordPendingMediaAllocation(allocation);

    expect(pendingMediaAllocation('stage-1', 'gen_img_1')).toMatchObject({ assetId: 'ast_old' });
    expect(pendingMediaAllocation('stage-2', 'gen_img_1')).toBeUndefined();
    expect(pendingMediaAllocation(undefined, 'gen_img_1')).toBeUndefined();
  });

  it('is drained by taking, so one allocation reaches one slide', () => {
    recordPendingMediaAllocation(allocation);

    expect(takePendingMediaAllocations('stage-1', ['gen_img_1'])).toHaveLength(1);
    expect(takePendingMediaAllocations('stage-1', ['gen_img_1'])).toHaveLength(0);
  });

  it('cannot be consumed by a later run once the course is cleared', () => {
    recordPendingMediaAllocation(allocation);
    recordPendingMediaAllocation({ ...allocation, stageId: 'stage-2', assetId: 'ast_other' });

    clearPendingMediaAllocations('stage-1');

    expect(takePendingMediaAllocations('stage-1', ['gen_img_1'])).toEqual([]);
    // Another course's parked work is untouched.
    expect(pendingMediaAllocation('stage-2', 'gen_img_1')).toMatchObject({ assetId: 'ast_other' });
  });

  it('clears every course when no course is named', () => {
    recordPendingMediaAllocation(allocation);
    recordPendingMediaAllocation({ ...allocation, stageId: 'stage-2' });

    clearPendingMediaAllocations();

    expect(pendingMediaAllocation('stage-1', 'gen_img_1')).toBeUndefined();
    expect(pendingMediaAllocation('stage-2', 'gen_img_1')).toBeUndefined();
  });

  it('separates courses whose ids share a prefix', () => {
    recordPendingMediaAllocation(allocation);
    recordPendingMediaAllocation({ ...allocation, stageId: 'stage-10', assetId: 'ast_ten' });

    clearPendingMediaAllocations('stage-1');

    expect(pendingMediaAllocation('stage-10', 'gen_img_1')).toMatchObject({ assetId: 'ast_ten' });
  });
});
